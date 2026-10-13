import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harnessRunDirectory, harnessRunsRoot, validateRunId } from "../journal/paths";
import { RUNTIME_VERSION } from "../journal/types";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import { DEFAULT_RESTRICTED_WORKFLOW_POLICY } from "../runtime/policy-host";
import { RunRuntime } from "../runtime/run-runtime";
import type { AgentNodeExecutor, RunSnapshot } from "../runtime/run-types";
import { isJsonObject, type JsonObject } from "../shared/json";
import { compileRestrictedWorkflow } from "../workflow/restricted/restricted-runtime";
import type { HarnessService } from "./service";
import type { WorkflowExecutionRecord } from "./types";

/** daemon 注入的执行器工厂产物；wiring 是 daemon 私有接线上下文，本服务不透明传递。 */
export type HarnessExecutionExecutor = {
  /** 实际注入 RunRuntime 的执行器（可含名额护栏包装）。 */
  readonly executor: AgentNodeExecutor;
  /** 需要绑定 ControlServer 的底座对象；仅 daemon 的 wireControl 钩子理解它。 */
  readonly wiring?: unknown;
};

/** daemon 注入的真实执行器接线；测试可全部省略。 */
export type HarnessExecutionHooks = {
  /** 真实执行器须在节点启动前绑定 ControlServer；由 daemon 注入，测试不注入。 */
  readonly wireControl?: (runtime: RunRuntime, wiring: unknown) => void | Promise<void>;
  /** 执行结束后的清理（如关闭终端观察器）；由 daemon 注入。 */
  readonly onSettled?: (executionId: string) => void | Promise<void>;
};

/**
 * 一个 Harness 的 WorkflowExecution 序列。Execution 内部复用完整 RunRuntime
 * （attempt/阶段访问/批次/replay/pause/recover/Control），本服务只负责：
 * 冻结 revision 校验、受限编译、Execution 登记事实与生命周期入口。
 * daemon 重启后不做任何自动继续；只有显式 resume 才重新编译冻结源码。
 */
export class HarnessExecutionService {
  /** 当前 daemon 生命周期内活跃的 Execution Runtime；离线档案只读重开。 */
  #runtimes = new Map<string, RunRuntime>();
  /** 活跃 Execution 的后台执行任务；控制操作要求任务在册。 */
  #tasks = new Map<string, Promise<void>>();
  /** 同一 Execution 的控制操作单飞；与 daemon runControl 同一纪律。 */
  #controlRequests = new Map<string, { readonly kind: string; readonly promise: Promise<unknown> }>();
  /** 同一 Execution 的 resume 单飞；必须在任一 await 前登记。 */
  #resumeRequests = new Map<string, Promise<RunSnapshot>>();
  /** 同一 Harness 的创建事务串行化；先登记成功才允许下一份冻结源码/Journal 出现。 */
  #creationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly harness: HarnessService,
    private readonly createExecutor: () => HarnessExecutionExecutor,
    private readonly hooks: HarnessExecutionHooks = {},
    private readonly root = harnessRunsRoot(),
  ) {}

  /** Execution 档案位于所属 Harness 档案内的嵌套 Run Store。 */
  private executionsRoot(harnessRunId: string): string {
    validateRunId(harnessRunId);
    return join(harnessRunDirectory(this.root, harnessRunId), "executions");
  }

  /** 创建并后台启动一次 Execution；只有已接受冻结的 revision 可以执行。 */
  async createExecution(harnessRunId: string, revisionNumber: number, input: JsonObject = {}): Promise<{ readonly execution: WorkflowExecutionRecord; readonly snapshot: RunSnapshot }> {
    return this.withCreationLock(harnessRunId, () => this.createExecutionOnce(harnessRunId, revisionNumber, input));
  }

  /**
   * 已取得 Harness 创建锁后的事务正文。这里才允许创建嵌套 Run Journal，避免两个
   * 并发请求都在 `recordExecutionCreated()` 的最终拒绝前留下未登记的孤儿档案。
   */
  private async createExecutionOnce(harnessRunId: string, revisionNumber: number, input: JsonObject): Promise<{ readonly execution: WorkflowExecutionRecord; readonly snapshot: RunSnapshot }> {
    const snapshot = await this.harness.snapshot(harnessRunId);
    const revision = snapshot.workflowRevisions.find((item) => item.revision === revisionNumber);
    if (!revision) throw new Error(`Workflow revision 不存在：${revisionNumber}`);
    if (revision.acceptedAt === null) throw new Error("只有已接受冻结的 revision 才能创建 Execution；草稿永远不能执行。 ");
    if (snapshot.executions.some((item) => item.finishedAt === null)) throw new Error("存在未结束的 WorkflowExecution；新 revision 必须等前一执行到达终态。 ");
    // 编译失败在任何耐久事实之前拒绝，不产生 Execution。
    const module = compileRestrictedWorkflow(revision.source);
    const policy = DEFAULT_RESTRICTED_WORKFLOW_POLICY;
    const executionId = crypto.randomUUID();
    const root = this.executionsRoot(harnessRunId);
    const directory = join(root, executionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sourcePath = join(directory, "source.ts");
    await writeFile(sourcePath, revision.source, { encoding: "utf8", mode: 0o600 });
    const created = this.createExecutor();
    const runtime = await RunRuntime.create({
      workflow: module, input, workflowSource: revision.source, clientRequestId: crypto.randomUUID(),
      workflowProjectCwd: snapshot.cwd, workflowPath: sourcePath, storeRoot: root,
      executor: created.executor,
      harness: { harnessRunId, revision: revision.revision, sourceHash: revision.sourceHash },
      runId: executionId,
    });
    const record: WorkflowExecutionRecord = { executionId, revision: revision.revision, sourceHash: revision.sourceHash, runtimeVersion: RUNTIME_VERSION, policy, createdAt: new Date().toISOString(), status: "running", finishedAt: null, diagnostic: null, summary: null };
    // Execution 登记事实先于首次调度落盘；Harness Journal 与 Execution Journal 相互可核对。
    // 若登记失败，刚由本调用创建的嵌套目录没有任何可达引用，立即清理，不能把它
    // 遗留成看似可 resume 的孤儿 Run。
    try {
      await this.harness.recordExecutionCreated(harnessRunId, record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await this.hooks.wireControl?.(runtime, created.wiring);
    this.startExecution(harnessRunId, executionId, runtime, module, policy);
    return { execution: record, snapshot: runtime.snapshot() };
  }

  /** 同一 Harness 按请求到达顺序创建；失败不会毒化之后的创建请求。 */
  private async withCreationLock<T>(harnessRunId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#creationLocks.get(harnessRunId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const settled = task.then(() => undefined, () => undefined);
    this.#creationLocks.set(harnessRunId, settled);
    try { return await task; }
    finally { if (this.#creationLocks.get(harnessRunId) === settled) this.#creationLocks.delete(harnessRunId); }
  }

  /** Harness 的 Execution 登记列表；重开 Harness Journal 即可还原，不依赖内存。 */
  async listExecutions(harnessRunId: string): Promise<readonly WorkflowExecutionRecord[]> {
    return (await this.harness.snapshot(harnessRunId)).executions;
  }

  /**
   * 新 daemon 启动时收敛遗留 Execution：ACP session 与原 Workflow 调用栈都不
   * 能跨进程认领，因此任何仍为 active 的嵌套 Run 都必须耐久标为 interrupted。
   * 此方法只落盘已有事实的终态，不创建 Worker、不重放脚本；恢复仍只能由用户
   * 显式调用 resume 发起。
   */
  async convergeStaleExecutions(harnessRunId: string): Promise<void> {
    const snapshot = await this.harness.snapshot(harnessRunId);
    for (const record of snapshot.executions) {
      // 一份损坏的历史嵌套档案只能使自己不可读取；不能让同一 Harness 后续的
      // active Execution 也逃过重启收敛，重新在 Web 中伪装为工作中。
      let runtime: RunRuntime;
      try {
        runtime = await RunRuntime.open(record.executionId, new DeterministicExecutor(), this.executionsRoot(harnessRunId));
      } catch {
        continue;
      }
      const current = runtime.snapshot();
      const activeNodes = current.phases.flatMap((phase) => phase.agents).filter((node) =>
        node.status === "running" || node.status === "blocked" || node.status === "pausing" || node.status === "paused" || node.status === "recovering",
      );
      // 已被旧版本写成 Run 终态的档案也可能残留 active 节点。只补齐节点事实，
      // 不改变 Run 终态或已完成节点，确保升级后的详情不会显示自相矛盾状态。
      if (current.status === "completed" || current.status === "cancelled" || current.status === "interrupted") {
        for (const node of activeNodes) {
          const nodeEvent: import("../journal/types").JournalEvent = {
            type: "agent.status", at: new Date().toISOString(), runId: record.executionId,
            nodeId: node.id, agentSessionId: node.agentSessionId,
            diagnostic: "daemon 重启后无法跨进程验证原 ACP 会话；按 Execution 终态收敛为 interrupted。", status: "interrupted",
          };
          await runtime.journal.append(nodeEvent);
          runtime.state.apply(nodeEvent);
        }
        if (record.finishedAt === null) await this.harness.recordExecutionFinished(harnessRunId, record.executionId, current.status, current.status === "completed" ? null : current.diagnostic, null);
        continue;
      }
      const diagnostic = `daemon 在 ${current.status} 中断；原 ACP 会话与 Workflow 调用栈不可跨进程认领，等待用户显式 resume。`;
      // Run 终态不能掩盖仍显示 running/blocked 的旧节点。先逐节点追加中断事实，
      // 再封存聚合状态，使详情、Phase 计数与 Harness 登记保持同一真相。
      for (const node of activeNodes) {
        const nodeEvent: import("../journal/types").JournalEvent = {
          type: "agent.status", at: new Date().toISOString(), runId: record.executionId,
          nodeId: node.id, agentSessionId: node.agentSessionId,
          diagnostic: "daemon 重启后无法跨进程验证原 ACP 会话；等待用户显式 resume。", status: "interrupted",
        };
        await runtime.journal.append(nodeEvent);
        runtime.state.apply(nodeEvent);
      }
      const event: import("../journal/types").JournalEvent = {
        type: "run.status", at: new Date().toISOString(), runId: record.executionId, nodeId: null, agentSessionId: null, diagnostic, status: "interrupted",
      };
      await runtime.journal.append(event);
      runtime.state.apply(event);
      await this.harness.recordExecutionFinished(harnessRunId, record.executionId, "interrupted", diagnostic, null);
    }
  }

  /** Execution 的权威 Run 快照；活跃实例优先，否则从 Journal 只读重开。 */
  async snapshotExecution(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    return (await this.runtimeFor(harnessRunId, executionId)).snapshot();
  }

  /** 暂停当前 Execution：阻断后续调度并停止既有节点；只对活跃实例有效。 */
  async pause(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    return this.control(harnessRunId, executionId, "pause", async (runtime) => {
      if (runtime.snapshot().status !== "running") throw new Error("只有 running 的 Execution 可以 pause。 ");
      return runtime.pause();
    });
  }

  /** 在同一受管会话中恢复已暂停的 Execution。 */
  async recover(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    return this.control(harnessRunId, executionId, "recover", async (runtime) => {
      if (runtime.snapshot().status !== "paused") throw new Error("只有 paused 的 Execution 可以 recover。 ");
      return runtime.recover();
    });
  }

  /** 用户停止是终态；pending 决策门随 Workflow 调用栈一起被拒绝。 */
  async stop(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    return this.control(harnessRunId, executionId, "stop", (runtime) => runtime.stop());
  }

  /** 用户对脚本决策门提交答案；Execution 必须在当前 daemon 活跃，否则应先显式 resume。 */
  async answerGate(harnessRunId: string, executionId: string, gateId: string, answer: JsonObject): Promise<RunSnapshot> {
    const runtime = this.#runtimes.get(executionId);
    if (!runtime || !this.#tasks.has(executionId)) throw new Error("该 Execution 不在当前 daemon 的可控制生命周期内；请先显式 resume。 ");
    await runtime.answerGate(gateId, answer);
    await this.harness.notifyExecutionChanged(harnessRunId, executionId);
    return runtime.snapshot();
  }

  /**
   * 用户显式恢复中断的 Execution：重新读取档案内冻结 source.ts 并校验 hash，
   * 只允许运行已接受脚本；同一 revision 的恢复产生新的 executionAttempt。
   */
  async resume(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    const inFlight = this.#resumeRequests.get(executionId);
    if (inFlight) return inFlight;
    const task = this.resumeOnce(harnessRunId, executionId).finally(() => this.#resumeRequests.delete(executionId));
    this.#resumeRequests.set(executionId, task);
    return task;
  }

  private async resumeOnce(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    if (this.#runtimes.has(executionId)) throw new Error("该 Execution 已在当前 daemon 运行，不能重复 resume。 ");
    const snapshot = await this.harness.snapshot(harnessRunId);
    const record = snapshot.executions.find((item) => item.executionId === executionId);
    if (!record) throw new Error("未知 WorkflowExecution。 ");
    const revision = snapshot.workflowRevisions.find((item) => item.revision === record.revision);
    if (!revision || revision.acceptedAt === null || revision.sourceHash !== record.sourceHash) throw new Error("Execution 绑定的 revision 不再是已接受冻结状态。 ");
    const root = this.executionsRoot(harnessRunId);
    const sourcePath = join(root, executionId, "source.ts");
    const source = await readFile(sourcePath, "utf8").catch(() => { throw new Error("Execution 冻结源码快照不可读取。 "); });
    if (createHash("sha256").update(source).digest("hex") !== record.sourceHash) throw new Error("Execution 冻结源码快照与登记 hash 不一致，fail closed。 ");
    const module = compileRestrictedWorkflow(source);
    const resumedExecutor = this.createExecutor();
    // daemon 在 paused/pausing/recovering 中退出时，原 Workflow 调用栈、决策门
    // waiter 和执行器均不存在；不能伪造 recover。用户明确 resume 时先如实把旧
    // 尝试收敛为 interrupted，再由标准 Replay 路径创建新 attempt。
    const opened = await RunRuntime.open(executionId, new DeterministicExecutor(), root);
    const previousStatus = opened.snapshot().status;
    if (previousStatus === "pausing" || previousStatus === "paused" || previousStatus === "recovering") {
      const event: import("../journal/types").JournalEvent = {
        type: "run.status", at: new Date().toISOString(), runId: executionId, nodeId: null, agentSessionId: null,
        diagnostic: `daemon 在 ${previousStatus} 中断；用户明确 resume 后创建新的 executionAttempt。`, status: "interrupted",
      };
      await opened.journal.append(event);
      opened.state.apply(event);
    } else if (previousStatus !== "running" && previousStatus !== "interrupted") {
      throw new Error("只有 daemon 中断的 Execution 可以 resume。 ");
    }
    // 外层登记与内嵌 Run 是两份独立 Journal。daemon 重启收敛时二者都会写成
    // interrupted；用户授权 resume 后必须先耐久地重开外层登记，后续新 attempt
    // 才能写入新的 execution_finished，而不是被旧终态拒绝。
    if (record.status === "interrupted") await this.harness.recordExecutionResumed(harnessRunId, executionId);
    const runtime = await RunRuntime.resume(executionId, resumedExecutor.executor, root);
    await this.hooks.wireControl?.(runtime, resumedExecutor.wiring);
    this.startExecution(harnessRunId, executionId, runtime, module, record.policy);
    return runtime.snapshot();
  }

  private async runtimeFor(harnessRunId: string, executionId: string): Promise<RunRuntime> {
    validateRunId(executionId);
    const live = this.#runtimes.get(executionId);
    if (live) return live;
    const snapshot = await this.harness.snapshot(harnessRunId);
    if (!snapshot.executions.some((item) => item.executionId === executionId)) throw new Error("未知 WorkflowExecution。 ");
    return RunRuntime.open(executionId, new DeterministicExecutor(), this.executionsRoot(harnessRunId));
  }

  private async control(harnessRunId: string, executionId: string, kind: "pause" | "recover" | "stop", operation: (runtime: RunRuntime) => Promise<RunSnapshot>): Promise<RunSnapshot> {
    const active = this.#controlRequests.get(executionId);
    if (active) {
      if (active.kind === kind) return active.promise as Promise<RunSnapshot>;
      throw new Error(`该 Execution 正在执行 ${active.kind}，不能同时执行 ${kind}。`);
    }
    const task = (async () => {
      const runtime = this.#runtimes.get(executionId);
      if (!runtime || !this.#tasks.has(executionId)) throw new Error("该 Execution 不在当前 daemon 的可控制生命周期内；请先显式 resume。 ");
      return operation(runtime);
    })().finally(() => this.#controlRequests.delete(executionId));
    this.#controlRequests.set(executionId, { kind, promise: task });
    const snapshot = await task;
    await this.harness.notifyExecutionChanged(harnessRunId, executionId);
    return snapshot;
  }

  /** 后台执行受限脚本；结束后登记终态事实并做展示通知。 */
  private startExecution(harnessRunId: string, executionId: string, runtime: RunRuntime, module: ReturnType<typeof compileRestrictedWorkflow>, policy: WorkflowExecutionRecord["policy"]): void {
    this.#runtimes.set(executionId, runtime);
    // run() 的返回值需要进入 summary，经闭包传递；整个 Execution 只调用一次 run()。
    let runtimeResult: unknown = null;
    const task = runtime.run(module, { policy })
      .then((result) => { runtimeResult = result; }, () => undefined)
      .then(async () => {
        // stop() 会先拒绝 pending gate 再写 cancelled；run() 的 rejection 可能先到达。
        // 等待快照收敛到终态再登记，避免把"停止中"误记为 interrupted。
        const deadline = Date.now() + 10_000;
        let snapshot = runtime.snapshot();
        while (snapshot.status !== "completed" && snapshot.status !== "cancelled" && snapshot.status !== "interrupted") {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          snapshot = runtime.snapshot();
        }
        const terminal = snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "interrupted" ? snapshot.status : "interrupted";
        // run() 返回值只在 completed 时有意义；非对象结果不进入摘要。
        const summary = terminal === "completed" && isJsonObject(runtimeResult) ? runtimeResult : null;
        await this.harness.recordExecutionFinished(harnessRunId, executionId, terminal, terminal === "completed" ? null : snapshot.diagnostic, summary);
      })
      .catch(() => undefined)
      .finally(async () => {
        this.#tasks.delete(executionId);
        await this.hooks.onSettled?.(executionId);
      });
    this.#tasks.set(executionId, task);
  }
}
