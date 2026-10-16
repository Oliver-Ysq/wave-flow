import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harnessRunDirectory, harnessRunsRoot, validateRunId, runsRoot } from "../journal/paths";
import { RUNTIME_VERSION } from "../journal/types";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import { DEFAULT_RESTRICTED_WORKFLOW_POLICY } from "../runtime/policy-host";
import { RunRuntime } from "../runtime/run-runtime";
import type { AgentNodeExecutor, RunSnapshot } from "../runtime/run-types";
import { isJsonObject, type JsonObject } from "../shared/json";
import { compileRestrictedWorkflow } from "../workflow/restricted/restricted-runtime";
import type { HarnessService } from "./service";
import type { ExecutionConfigSnapshot, WorkflowExecutionRecord } from "./types";
import { assertStartable } from "./task-contract";
import { RunJournal } from "../journal/run-journal";
import { HarnessJournal } from "./journal";
import { canonicalJson, validateTemplateInput } from "./workflow-templates";
import {loadWorkflowSource} from "../workflow/load-workflow";
import {preflightLocalWorkflow,validateLocalInput} from "../workflow/preflight-local";

/** Engine 注入的执行器工厂产物；wiring 是 Engine 私有接线上下文，本服务不透明传递。 */
export type HarnessExecutionExecutor = {
  /** 实际注入 RunRuntime 的执行器（可含名额护栏包装）。 */
  readonly executor: AgentNodeExecutor;
  /** 需要绑定 ControlServer 的底座对象；仅 Engine 的 wireControl 钩子理解它。 */
  readonly wiring?: unknown;
};

/** Engine 注入的真实执行器接线；测试可全部省略。 */
export type HarnessExecutionHooks = {
  /**
   * 节点启动前绑定本实例的 ControlServer；缺省不接线。可返回同步释放器，捕获
   * 本次具体资源身份，在耐久终态后退役时调用一次；不得按 executionId 清理新实例。
   */
  readonly wireControl?: (runtime: RunRuntime, wiring: unknown) => void | (() => void) | Promise<void | (() => void)>;
};

/**
 * 一个 Harness 的 WorkflowExecution 序列。Execution 内部复用完整 RunRuntime
 * （attempt/阶段访问/批次/replay/pause/recover/Control），本服务只负责：
 * 冻结 revision 校验、受限编译、Execution 登记事实与生命周期入口。
 * Engine 重启后不做任何自动继续；只有显式 resume 才重新编译冻结源码。
 */
export class HarnessExecutionService {
  /** 当前 Engine 的唯一活跃执行实例；Runtime 与控制资源共同取得/撤销所有权。 */
  #instances = new Map<string, ExecutionInstance>();
  /** 同一 Execution 的控制操作单飞；与 Engine runControl 同一纪律。 */
  #controlRequests = new Map<string, { readonly kind: string; readonly promise: Promise<unknown> }>();
  /** 同一 Execution 的 resume 单飞；必须在任一 await 前登记。 */
  #resumeRequests = new Map<string, {readonly owner:string;readonly promise:Promise<RunSnapshot>}>();

  constructor(
    private readonly harness: HarnessService,
    /** 执行器工厂；受限来源传冻结分配快照，本地来源传 null 并保留作者 CLI。 */
    private readonly createExecutor: (config: ExecutionConfigSnapshot | null) => HarnessExecutionExecutor,
    private readonly hooks: HarnessExecutionHooks = {},
    private readonly root = harnessRunsRoot(),
    /** 独立本地Run Store；Engine显式传入，不复制节点状态。 */
    private readonly localStoreRoot = runsRoot(),
  ) {}

  /** Execution 档案位于所属 Harness 档案内的嵌套 Run Store。 */
  private executionsRoot(harnessRunId: string): string {
    validateRunId(harnessRunId);
    return join(harnessRunDirectory(this.root, harnessRunId), "executions");
  }

  /** 先验证Task归属，再按来源路由原Store。 */
  private async storeFor(harnessRunId:string,executionId:string):Promise<string>{
    const record=(await this.harness.snapshot(harnessRunId)).executions.find(item=>item.executionId===executionId);
    if(!record)throw new Error("执行不属于当前任务。");
    return record.kind==="local-run"?this.localStoreRoot:this.executionsRoot(harnessRunId);
  }

  /** 创建并后台启动一次已确认的执行。 */
  async createExecution(harnessRunId: string, revisionNumber: number, input: JsonObject = {}, config?: ExecutionConfigSnapshot, confirmation?: Pick<WorkflowExecutionRecord,"confirmationRequestId"|"confirmationPayloadHash">): Promise<{ readonly execution: WorkflowExecutionRecord; readonly snapshot: RunSnapshot }> {
    return this.withLifecycleLock(harnessRunId, () => this.createExecutionOnce(harnessRunId, revisionNumber, input, config ?? null, confirmation));
  }

  /**
   * 已取得 Harness 创建锁后的事务正文。这里才允许创建嵌套 Run Journal，避免两个
   * 并发请求都在 `recordExecutionCreated()` 的最终拒绝前留下未登记的孤儿档案。
   */
  private async createExecutionOnce(harnessRunId: string, revisionNumber: number, input: JsonObject, config: ExecutionConfigSnapshot | null, confirmation?: Pick<WorkflowExecutionRecord,"confirmationRequestId"|"confirmationPayloadHash">): Promise<{ readonly execution: WorkflowExecutionRecord; readonly snapshot: RunSnapshot }> {
    const snapshot = await this.harness.snapshot(harnessRunId);
    if (snapshot.task) assertStartable(snapshot, revisionNumber);
    const revision = snapshot.workflowRevisions.find((item) => item.revision === revisionNumber);
    if (!revision) throw new Error(`Workflow revision 不存在：${revisionNumber}`);
    if (revision.acceptedAt === null) throw new Error("只有已接受冻结的 revision 才能创建 Execution；草稿永远不能执行。 ");
    if(revision.templateOrigin){
      validateTemplateInput(revision.templateOrigin.inputSchema,input);
      if(canonicalJson(input)!==canonicalJson(revision.input))throw new Error("输入与已批准模板版本不一致。");
    }
    if (snapshot.executions.some((item) => item.finishedAt === null)) throw new Error("存在未结束的 WorkflowExecution；新 revision 必须等前一执行到达终态。 ");
    // 受限 Execution 的脚本字面量 cli/model 不直接生效；没有分配卡冻结的快照就没有
    // 任何诚实依据决定节点落到哪个 Runtime，必须在任何耐久事实之前拒绝。
    if (!revision.localOrigin && !config) throw new Error("创建 Harness Execution 必须携带分配卡冻结的执行配置快照。 ");
    if (revision.localOrigin && config) throw new Error("本地 Workflow 不接受 CLI 分配配置，请使用作者声明。 ");
    // 编译失败在任何耐久事实之前拒绝，不产生 Execution。
    if(revision.localOrigin){
      const checked=await preflightLocalWorkflow(revision.localOrigin.path,snapshot.cwd);
      if(checked.sourceHash!==revision.sourceHash)throw new Error("本地来源启动前已变化，请重新预检。");
      validateLocalInput(revision.localOrigin.inputSchema,input);
      if(canonicalJson(input)!==canonicalJson(revision.input))throw new Error("本地输入与批准版本不匹配。");
    }
    const module = revision.localOrigin?await loadWorkflowSource(revision.source,revision.localOrigin.path):compileRestrictedWorkflow(revision.source);
    const policy = DEFAULT_RESTRICTED_WORKFLOW_POLICY;
    const executionId = crypto.randomUUID();
    const root = revision.localOrigin?this.localStoreRoot:this.executionsRoot(harnessRunId);
    const directory = join(root, executionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sourcePath = join(directory, "source.ts");
    await writeFile(sourcePath, revision.source, { encoding: "utf8", mode: 0o600 });
    let created: HarnessExecutionExecutor;
    let runtime: RunRuntime;
    try {
    created = this.createExecutor(revision.localOrigin?null:config);
    runtime = await RunRuntime.create({
      workflow: module, input, workflowSource: revision.source, clientRequestId: crypto.randomUUID(),
      workflowProjectCwd: snapshot.cwd, workflowPath: sourcePath, storeRoot: root,
      executor: created.executor,
      harness: { harnessRunId, revision: revision.revision, sourceHash: revision.sourceHash },
      runId: executionId,
      executionConfig: revision.localOrigin?undefined:config??undefined,
    });
    } catch(error) {
      // prepare 尚未取得Task关联；只清理本调用生成的UUID目录，不触碰用户工作区。
      await rm(directory,{recursive:true,force:true}).catch(()=>{});
      throw error;
    }
    const record: WorkflowExecutionRecord = { ...confirmation, kind:revision.localOrigin?"local-run":"restricted-execution", executionId, revision: revision.revision, sourceHash: revision.sourceHash, runtimeVersion: RUNTIME_VERSION, policy, createdAt: new Date().toISOString(), status: "running", finishedAt: null, diagnostic: null, summary: null, ...(config ? {config} : {}) };
    // Execution 登记事实先于首次调度落盘；Harness Journal 与 Execution Journal 相互可核对。
    // 若登记失败，刚由本调用创建的嵌套目录没有任何可达引用，立即清理，不能把它
    // 遗留成看似可 resume 的孤儿 Run。
    try {
      await this.harness.recordExecutionCreated(harnessRunId, record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    let releaseControl:void|(()=>void);
    try { releaseControl = await this.hooks.wireControl?.(runtime, created.wiring); }
    catch(error){
      const diagnostic=`执行已创建，但控制初始化失败：${error instanceof Error?error.message:String(error)}`;
      const event:import("../journal/types").JournalEvent={type:"run.status",at:new Date().toISOString(),runId:executionId,nodeId:null,agentSessionId:null,status:"interrupted",diagnostic};
      await runtime.journal.append(event);runtime.state.apply(event);
      await this.harness.recordExecutionFinished(harnessRunId,executionId,"interrupted",diagnostic,null,runtime.snapshot().currentExecutionAttemptId);
      throw error;
    }
    this.startExecution(harnessRunId, executionId, runtime, module, policy, releaseControl,!!revision.localOrigin);
    return { execution: record, snapshot: runtime.snapshot() };
  }

  /** 同一 Harness 按到达顺序提交执行生命周期事务；失败不毒化后续请求。 */
  private async withLifecycleLock<T>(harnessRunId: string, operation: () => Promise<T>): Promise<T> {
    return this.harness.lifecycle.run(harnessRunId, operation);
  }

  /** Harness 的 Execution 登记列表；重开 Harness Journal 即可还原，不依赖内存。 */
  async listExecutions(harnessRunId: string): Promise<readonly WorkflowExecutionRecord[]> {
    return (await this.harness.snapshot(harnessRunId)).executions;
  }

  /**
   * 新 Engine 启动时收敛遗留 Execution：ACP session 与原 Workflow 调用栈都不
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
        runtime = await RunRuntime.open(record.executionId, new DeterministicExecutor(), await this.storeFor(harnessRunId,record.executionId));
      } catch {
        continue;
      }
      const current = runtime.snapshot();
      const activeNodes = current.phases.flatMap((phase) => phase.agents).filter((node) =>
        node.status === "queued" || node.status === "running" || node.status === "blocked" || node.status === "pausing" || node.status === "paused" || node.status === "recovering",
      );
      // 已被旧版本写成 Run 终态的档案也可能残留 active 节点。只补齐节点事实，
      // 不改变 Run 终态或已完成节点，确保升级后的详情不会显示自相矛盾状态。
      if (current.status === "completed" || current.status === "cancelled" || current.status === "interrupted") {
        for (const node of activeNodes) {
          const nodeEvent: import("../journal/types").JournalEvent = {
            type: "agent.status", at: new Date().toISOString(), runId: record.executionId,
            nodeId: node.id, agentSessionId: node.agentSessionId,
            diagnostic: "Engine 重启后无法跨进程验证原 ACP 会话；按 Execution 终态收敛为 interrupted。", status: "interrupted",
          };
          await runtime.journal.append(nodeEvent);
          runtime.state.apply(nodeEvent);
        }
        if (record.finishedAt === null) await this.harness.recordExecutionFinished(harnessRunId, record.executionId, current.status, current.status === "completed" ? null : current.diagnostic, null,current.currentExecutionAttemptId);
        continue;
      }
      const diagnostic = `Engine 在 ${current.status} 中断；原 ACP 会话与 Workflow 调用栈不可跨进程认领，等待用户显式 resume。`;
      // Run 终态不能掩盖仍显示 running/blocked 的旧节点。先逐节点追加中断事实，
      // 再封存聚合状态，使详情、Phase 计数与 Harness 登记保持同一真相。
      for (const node of activeNodes) {
        const nodeEvent: import("../journal/types").JournalEvent = {
          type: "agent.status", at: new Date().toISOString(), runId: record.executionId,
          nodeId: node.id, agentSessionId: node.agentSessionId,
          diagnostic: "Engine 重启后无法跨进程验证原 ACP 会话；等待用户显式 resume。", status: "interrupted",
        };
        await runtime.journal.append(nodeEvent);
        runtime.state.apply(nodeEvent);
      }
      const event: import("../journal/types").JournalEvent = {
        type: "run.status", at: new Date().toISOString(), runId: record.executionId, nodeId: null, agentSessionId: null, diagnostic, status: "interrupted",
      };
      await runtime.journal.append(event);
      runtime.state.apply(event);
      await this.harness.recordExecutionFinished(harnessRunId, record.executionId, "interrupted", diagnostic, null,current.currentExecutionAttemptId);
    }
  }

  /** Execution 的权威 Run 快照；活跃实例优先，否则从 Journal 只读重开。 */
  async snapshotExecution(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    return (await this.runtimeFor(harnessRunId, executionId)).snapshot();
  }

  /**
   * 只读分页读取 Execution 的 Phase 访问。attempt 缺省时聚合全部已耐久 attempt，
   * 按（attempt, phaseVisitId）稳定排序，cursor 编码为 attempt * 1_000_000 + phaseVisitId；
   * 指定 attempt 时语义与 RunRuntime 单尝试分页一致（cursor 为 phaseVisitId）。
   * 用途：UI 补齐"本次未访问但历史访问已交付并被 replay 复用"的 Phase → Agent 关系；
   * 数据全部来自耐久 Journal，不得用于推断 TypeScript 控制流。
   */
  async listExecutionPhaseVisits(
    harnessRunId: string,
    executionId: string,
    options: { readonly attempt?: number | null; readonly cursor?: number | null; readonly includeEmpty?: boolean; readonly limit?: number } = {},
  ): Promise<{ readonly items: readonly import("../runtime/run-types").PhaseVisitSnapshot[]; readonly nextCursor: number | null }> {
    const runtime = await this.runtimeFor(harnessRunId, executionId);
    const limit = options.limit ?? 20;
    const cursor = options.cursor ?? null;
    const includeEmpty = options.includeEmpty === true;
    if (options.attempt !== undefined && options.attempt !== null) {
      if (!runtime.state.hasExecutionAttempt(options.attempt)) throw new Error("指定执行尝试不存在。 ");
      return runtime.state.listPhaseVisits(options.attempt, cursor, limit, includeEmpty);
    }
    const attempts = runtime.state.executionAttemptIds();
    const all = attempts.flatMap((attempt) => runtime.state.listPhaseVisits(attempt, null, Number.MAX_SAFE_INTEGER, includeEmpty).items);
    const keyOf = (visit: import("../runtime/run-types").PhaseVisitSnapshot): number => visit.executionAttemptId * 1_000_000 + visit.phaseVisitId;
    const sorted = [...all].sort((left, right) => keyOf(left) - keyOf(right));
    const visible = cursor === null ? sorted : sorted.filter((visit) => keyOf(visit) > cursor);
    const items = visible.slice(0, limit);
    return { items, nextCursor: visible.length > items.length ? keyOf(items.at(-1)!) : null };
  }

  /**
   * Execution 是否处于当前 Engine 的可控制生命周期内（本进程持有活跃实例）。
   * Engine 重启后旧 Execution 的耐久状态可能仍是 running/paused，但 pause/stop/answerGate
   * 都会拒绝；UI 依此提供显式 resume 入口，而不是展示注定失败的控制按钮。
   */
  isControllable(executionId: string): boolean {
    return this.#instances.has(executionId);
  }

  /** 活跃实例的轻量待答投影；不读取历史节点结果，不作为控制授权。 */
  attention(executionId:string): { readonly workerRequests:number; readonly scriptGates:number } {
    const snapshot=this.#instances.get(executionId)?.runtime.snapshot();
    return {workerRequests:snapshot?.phases.flatMap(phase=>phase.agents).filter(agent=>agent.status==="blocked").length ?? 0,scriptGates:snapshot?.status==="running" ? snapshot.gates.filter(gate=>gate.answer===null).length : 0};
  }

  /** 特定 attempt 的只读证据；新格式显式身份，旧格式按事件顺序绑定，不猜时间。 */
  async attemptResults(harnessRunId:string,executionId:string,attempt:number):Promise<import("../desktop/types").ExecutionAttemptResultsResponse> {
    await this.runtimeFor(harnessRunId,executionId); // 先校验所属 Task，不凭 id 读取其他任务。
    const run=await RunJournal.open(executionId,await this.storeFor(harnessRunId,executionId));
    const starts=run.events.filter(event=>event.type==="execution-attempt.started");
    const start=starts.find(event=>event.executionAttemptId===attempt);
    if(!start)throw new Error("指定执行尝试不存在。");
    const task=await HarnessJournal.open(harnessRunId,this.root);
    // 原 Run 的 attempt/终态顺序是权威；失败 resume 不一定建立新 attempt。
    let readingAttempt=0;
    let runStatus:import("../runtime/run-types").RunSnapshot["status"]|null=null;
    for(const event of run.events){
      if(event.type==="execution-attempt.started")readingAttempt=event.executionAttemptId??0;
      if(readingAttempt===attempt&&event.type==="run.status"&&["completed","cancelled","interrupted"].includes(event.status??""))runStatus=event.status??null;
    }
    let terminal:Extract<import("./journal").HarnessEvent,{type:"workflow.execution_finished"}>|undefined;
    for(const event of task.events){
      if(event.type==="workflow.execution_finished"&&event.executionId===executionId&&event.attempt===attempt)terminal=event;
    }
    // 已完成 Execution 不可再 resume；旧格式唯一 completed summary 可绑定原 Run 的 completed attempt。
    if(!terminal&&runStatus==="completed")terminal=task.events.filter((event):event is Extract<import("./journal").HarnessEvent,{type:"workflow.execution_finished"}>=>event.type==="workflow.execution_finished"&&event.executionId===executionId&&event.status==="completed"&&event.attempt===undefined).at(-1);
    const visits=(await this.runtimeFor(harnessRunId,executionId)).state.listPhaseVisits(attempt,null,1000,true).items;
    return {executionId,attempt,status:runStatus??terminal?.status??null,summary:terminal?.summary??null,nodes:visits.flatMap(visit=>visit.batches.flatMap(batch=>batch.agents)).filter(agent=>agent.status==="completed").map(agent=>({id:agent.id,label:agent.label,result:agent.result}))};
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

  /** Desktop 退出时同步写 cancelled，随后异步请求已启动 Worker 停止。 */
  async cancelForDesktopExit(engineInstanceId: string): Promise<void> {
    for (const [executionId, instance] of [...this.#instances]) {
      const { runtime } = instance;
      const snapshot = runtime.snapshot();
      if (snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "interrupted") continue;
      const harnessRunId = runtime.journal.manifest.harness?.harnessRunId;
      if (!harnessRunId) continue;
      await this.withLifecycleLock(harnessRunId, async () => {
        if (this.#instances.get(executionId) !== instance) return;
        await runtime.cancelForDesktopExit(engineInstanceId);
        await this.harness.recordExecutionFinished(harnessRunId, executionId, "cancelled", "退出 Wave Flow 时停止。 ", null,runtime.snapshot().currentExecutionAttemptId);
        // 耐久取消后立即退役，不等待旧调用栈；释放器与实例在此一起撤销所有权。
        this.retireInstance(executionId, instance);
      });
    }
  }

  /** 用户对脚本决策门提交答案；Execution 必须在当前 Engine 活跃，否则应先显式 resume。 */
  async answerGate(harnessRunId: string, executionId: string, gateId: string, answer: JsonObject): Promise<RunSnapshot> {
    return this.withLifecycleLock(harnessRunId,async()=>{
    await this.runtimeFor(harnessRunId,executionId);
    const runtime = this.#instances.get(executionId)?.runtime;
    if (!runtime) throw new Error("该 Execution 不在当前 Engine 的可控制生命周期内；请先显式 resume。 ");
    const record=(await this.harness.snapshot(harnessRunId)).executions.find(item=>item.executionId===executionId);
    // 显式 resume 已登记 running 时，原 Runtime 可能还在建立 attempt；答案仍可耐久交付。
    if(record?.finishedAt!==null||record.status!=="running")throw new Error("只有运行中的原Execution可以回答决策门。");
    await runtime.answerGate(gateId, answer);
    await this.harness.notifyExecutionChanged(harnessRunId, executionId);
    return runtime.snapshot();
    });
  }

  /**
   * 用户显式恢复中断的 Execution：重新读取档案内冻结 source.ts 并校验 hash，
   * 只允许运行已接受脚本；同一 revision 的恢复产生新的 executionAttempt。
   */
  async resume(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    const inFlight = this.#resumeRequests.get(executionId);
    if (inFlight) {if(inFlight.owner!==harnessRunId)throw new Error("Execution 不属于当前任务。");return inFlight.promise;}
    const task = this.withLifecycleLock(harnessRunId, () => this.resumeOnce(harnessRunId, executionId)).finally(() => this.#resumeRequests.delete(executionId));
    this.#resumeRequests.set(executionId, {owner:harnessRunId,promise:task});
    return task;
  }

  private async resumeOnce(harnessRunId: string, executionId: string): Promise<RunSnapshot> {
    if (this.#instances.has(executionId)) throw new Error("该 Execution 已在当前 Engine 运行，不能重复 resume。 ");
    const snapshot = await this.harness.snapshot(harnessRunId);
    if (snapshot.task && snapshot.status !== "idle") throw new Error("主控空闲且任务未归档时才能恢复原执行。");
    const record = snapshot.executions.find((item) => item.executionId === executionId);
    if (!record) throw new Error("未知 WorkflowExecution。 ");
    if (snapshot.task?.workflowContract === "single-workflow-v1" && snapshot.executions.at(-1)?.executionId !== executionId) throw new Error("已有较新执行，旧执行只能查看历史，不能恢复。");
    // 分配快照随登记事实耐久；缺失说明档案早于分配卡机制，没有诚实依据重建生效请求。
    if (record.kind !== "local-run" && !record.config) throw new Error("该 Execution 缺少分配卡冻结的执行配置快照，不能 resume。 ");
    const revision = snapshot.workflowRevisions.find((item) => item.revision === record.revision);
    if (!revision || revision.acceptedAt === null || revision.sourceHash !== record.sourceHash) throw new Error("Execution 绑定的 revision 不再是已接受冻结状态。 ");
    const root = await this.storeFor(harnessRunId,executionId);
    const sourcePath = join(root, executionId, "source.ts");
    const source = await readFile(sourcePath, "utf8").catch(() => { throw new Error("Execution 冻结源码快照不可读取。 "); });
    if (createHash("sha256").update(source).digest("hex") !== record.sourceHash) throw new Error("Execution 冻结源码快照与登记 hash 不一致，fail closed。 ");
    const module = record.kind==="local-run"?await loadWorkflowSource(source,revision.localOrigin?.path):compileRestrictedWorkflow(source);
    const resumedExecutor = this.createExecutor(record.kind==="local-run"?null:record.config??null);
    // Engine 在 paused/pausing/recovering 中退出时，原 Workflow 调用栈、决策门
    // waiter 和执行器均不存在；不能伪造 recover。用户明确 resume 时先如实把旧
    // 尝试收敛为 interrupted，再由标准 Replay 路径创建新 attempt。
    const opened = await RunRuntime.open(executionId, new DeterministicExecutor(), root);
    const previousStatus = opened.snapshot().status;
    if (previousStatus === "pausing" || previousStatus === "paused" || previousStatus === "recovering") {
      const event: import("../journal/types").JournalEvent = {
        type: "run.status", at: new Date().toISOString(), runId: executionId, nodeId: null, agentSessionId: null,
        diagnostic: `Engine 在 ${previousStatus} 中断；用户明确 resume 后创建新的 executionAttempt。`, status: "interrupted",
      };
      await opened.journal.append(event);
      opened.state.apply(event);
    } else if (previousStatus !== "running" && previousStatus !== "interrupted" && previousStatus !== "cancelled") {
      throw new Error("只有中断或取消的 Execution 可以 resume。 ");
    }
    // 旧版本缺陷或执行器在 blocked 等待期间死亡，可能留下"终态 Run + 活跃节点"的档案；
    // replay 遇到 running/blocked 节点会 fail closed 拒绝重放。与 Engine 重启收敛同样，
    // 显式 resume 前先把这些不可认领的节点耐久收敛为 interrupted，replay 才能从首个
    // 非 completed 节点创建新 attempt。
    const staleNodes = opened.snapshot().phases.flatMap((phase) => phase.agents).filter((node) =>
      node.status === "queued" || node.status === "running" || node.status === "blocked" || node.status === "pausing" || node.status === "paused" || node.status === "recovering",
    );
    for (const node of staleNodes) {
      const nodeEvent: import("../journal/types").JournalEvent = {
        type: "agent.status", at: new Date().toISOString(), runId: executionId,
        nodeId: node.id, agentSessionId: node.agentSessionId,
        diagnostic: "用户显式 resume；旧 attempt 遗留的活跃节点不可认领，收敛为 interrupted 后由新 attempt 重新调度。", status: "interrupted",
      };
      await opened.journal.append(nodeEvent);
      opened.state.apply(nodeEvent);
    }
    // 外层登记与内嵌 Run 是两份独立 Journal。Engine 重启收敛时二者都会写成
    // interrupted/cancelled；用户授权 resume 后必须先耐久地重开外层登记，后续新 attempt
    // 才能写入新的 execution_finished，而不是被旧终态拒绝。
    if (record.status === "interrupted" || record.status === "cancelled") await this.harness.recordExecutionResumed(harnessRunId, executionId);
    const runtime = await RunRuntime.resume(executionId, resumedExecutor.executor, root, record.kind==="local-run"?null:record.config);
    const releaseControl = await this.hooks.wireControl?.(runtime, resumedExecutor.wiring);
    this.startExecution(harnessRunId, executionId, runtime, module, record.policy, releaseControl,record.kind==="local-run");
    return runtime.snapshot();
  }

  private async runtimeFor(harnessRunId: string, executionId: string): Promise<RunRuntime> {
    validateRunId(executionId);
    const snapshot = await this.harness.snapshot(harnessRunId);
    if (!snapshot.executions.some((item) => item.executionId === executionId)) throw new Error("未知 WorkflowExecution。 ");
    const live = this.#instances.get(executionId)?.runtime;
    if (live) return live;
    return RunRuntime.open(executionId, new DeterministicExecutor(), await this.storeFor(harnessRunId,executionId));
  }

  private async control(harnessRunId: string, executionId: string, kind: "pause" | "recover" | "stop", operation: (runtime: RunRuntime) => Promise<RunSnapshot>): Promise<RunSnapshot> {
    const owner=await this.harness.snapshot(harnessRunId);
    if(owner.status==="completed"||!owner.executions.some(execution=>execution.executionId===executionId))throw new Error("Execution 不属于当前可控制任务。");
    const active = this.#controlRequests.get(executionId);
    if (active) {
      if (active.kind === kind) return active.promise as Promise<RunSnapshot>;
      throw new Error(`该 Execution 正在执行 ${active.kind}，不能同时执行 ${kind}。`);
    }
    const task = (async () => {
      await this.withLifecycleLock(harnessRunId,async()=>{const current=await this.harness.snapshot(harnessRunId);if(current.status==="completed"||!current.executions.some(execution=>execution.executionId===executionId))throw new Error("任务已归档或执行归属无效。");});
      const runtime = this.#instances.get(executionId)?.runtime;
      if (!runtime) throw new Error("该 Execution 不在当前 Engine 的可控制生命周期内；请先显式 resume。 ");
      return operation(runtime);
    })().finally(() => this.#controlRequests.delete(executionId));
    this.#controlRequests.set(executionId, { kind, promise: task });
    const snapshot = await task;
    await this.harness.notifyExecutionChanged(harnessRunId, executionId);
    return snapshot;
  }

  /** 后台执行受限脚本；结束后登记终态事实并做展示通知。 */
  private startExecution(harnessRunId: string, executionId: string, runtime: RunRuntime, module: ReturnType<typeof compileRestrictedWorkflow>, policy: WorkflowExecutionRecord["policy"], releaseControl: void | (() => void), local = false): void {
    const instance: ExecutionInstance = { runtime, releaseControl };
    this.#instances.set(executionId, instance);
    // run() 的返回值需要进入 summary，经闭包传递；整个 Execution 只调用一次 run()。
    let runtimeResult: unknown = null;
    // run() 的 rejection 是本 attempt 失败的直接原因，必须保留到 settle 登记；
    // 否则 resume 重放被拒等场景下只能读到上一次 attempt 的旧诊断，真实错误永久丢失。
    let runtimeError: Error | null = null;
    void this.harness.lifecycle.outside(()=>runtime.run(module, local ? {} : { policy }))
      .then((result) => { runtimeResult = result; }, (error: unknown) => { runtimeError = error instanceof Error ? error : new Error(String(error)); })
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
        // interrupted 优先采用本次 run() 的真实 rejection；snapshot.diagnostic 可能是
        // 旧 attempt 遗留的终态诊断（例如 resume 重放在首个节点前被拒，快照从未更新）。
        // cancelled 的诊断以快照为准（"用户停止"/"退出 Wave Flow" 语义由控制路径耐久）。
        const diagnostic = terminal === "completed" ? null
          : terminal === "interrupted" && runtimeError ? runtimeError.message
          : snapshot.diagnostic;
        // 终态发布与 resume 共用 Harness 事务锁：身份校验和 append 之间不能换代。
        await this.withLifecycleLock(harnessRunId, async () => {
          if (this.#instances.get(executionId) !== instance) return;
          await this.harness.recordExecutionFinished(harnessRunId, executionId, terminal, diagnostic, summary,snapshot.currentExecutionAttemptId);
          this.retireInstance(executionId, instance);
        });
      })
      .catch(() => undefined)
      .finally(() => {
        this.retireInstance(executionId, instance);
      });
  }

  /** 只退役仍归本实例所有的资源；迟到任务不能按稳定业务 id 删除新实例。 */
  private retireInstance(executionId: string, instance: ExecutionInstance): void {
    if (this.#instances.get(executionId) !== instance) return;
    this.#instances.delete(executionId);
    instance.releaseControl?.();
  }
}

/** Engine 内一次实际执行的所有权；对象身份独立于持久 executionId/attempt。 */
type ExecutionInstance = {
  /** 该实例独占的 Runtime、调用栈和决策门等待者。 */
  readonly runtime: RunRuntime;
  /** 接线时捕获的同步资源释放器；缺省表示没有外部 Control 资源。 */
  readonly releaseControl: void | (() => void);
};
