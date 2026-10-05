import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { runsRoot } from "../journal/paths";
import { RunJournal } from "../journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../journal/types";
import type { JsonObject } from "../shared/json";
import type { WorkflowModule } from "../shared/workflow-types";
import { executeWorkflow } from "../workflow/execute-workflow";
import { RunRuntimeHost } from "./run-runtime-host";
import { RunStateMachine } from "./run-state-machine";
import type { AgentNodeExecutor, RunSnapshot } from "./run-types";
import { ControlServer } from "../control/control-server";

/** 创建一次耐久 Run 所需的公开配置。 */
export type CreateRunOptions = {
  /** 受信任、已加载的 Workflow 模块。 */
  readonly workflow: WorkflowModule<JsonObject, unknown>;
  /** 本次 Workflow JSON-safe 输入。 */
  readonly input: JsonObject;
  /** Workflow 主文件内容；用于生成本次 Manifest 的 hash。 */
  readonly workflowSource: string;
  /** CLI 创建请求的稳定 UUID；重试时必须保持不变。 */
  readonly clientRequestId: string;
  /** Workflow 所属项目目录；用于相对节点 cwd 解析。 */
  readonly workflowProjectCwd: string;
  /** realpath 后的 Workflow 文件。 */
  readonly workflowPath: string;
  /** 用户级 Run Store 根目录；仅供 daemon / 测试注入。 */
  readonly storeRoot?: string;
  /** 本章可控 Agent 执行器；不启动真实 CLI。 */
  readonly executor: AgentNodeExecutor;
};

/** 本章 Runtime 的创建、执行与查询入口。 */
export class RunRuntime {
  private constructor(
    readonly journal: RunJournal,
    readonly state: RunStateMachine,
    private readonly host: RunRuntimeHost,
  ) {}

  /** 创建 Manifest、Journal、状态机与 Host，尚不执行 Workflow。 */
  static async create(options: CreateRunOptions): Promise<RunRuntime> {
    const workflowProjectCwd = await realpath(options.workflowProjectCwd);
    const workflowPath = await realpath(options.workflowPath);
    const manifest: RunManifest = {
      runId: crypto.randomUUID(), clientRequestId: options.clientRequestId, runtimeVersion: RUNTIME_VERSION, workflow: options.workflow.meta,
      workflowHash: createHash("sha256").update(options.workflowSource).digest("hex"), workflowPath, workflowProjectCwd, input: options.input, createdAt: new Date().toISOString(),
    };
    const journal = await RunJournal.create(manifest, options.storeRoot ?? runsRoot());
    const state = new RunStateMachine(manifest);
    state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    return new RunRuntime(journal, state, new RunRuntimeHost(journal, state, options.executor));
  }

  /** 打开已有 Run 并从已验证 Journal 事实重建 Phase → Agent 查询视图。 */
  static async open(runId: string, executor: AgentNodeExecutor, storeRoot = runsRoot()): Promise<RunRuntime> {
    const opened = await RunJournal.open(runId, storeRoot);
    const state = new RunStateMachine(opened.journal.manifest);
    for (const event of opened.events) state.apply(event);
    const sequence = state.snapshot().phases.flatMap((phase) => phase.agents).length;
    return new RunRuntime(opened.journal, state, new RunRuntimeHost(opened.journal, state, executor, sequence));
  }

  /** 执行 Workflow；完成后以 durable run.status 事实封存聚合状态。 */
  async run(workflow: WorkflowModule<JsonObject, unknown>): Promise<unknown> {
    try {
      const result = await executeWorkflow(workflow, this.journal.manifest.input, this.host, { cwd: this.journal.manifest.workflowProjectCwd });
      await this.host.flush();
      const nodes = this.state.snapshot().phases.flatMap((phase) => phase.agents);
      if (nodes.some((agent) => agent.status !== "completed")) throw new Error("Workflow 返回时仍有未完成 Agent 节点。");
      await this.transitionRun("completed", null);
      return result;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (this.state.snapshot().status === "running") await this.transitionRun("interrupted", diagnostic);
      throw error;
    }
  }

  /** 返回当前不可变查询投影。 */
  snapshot(): RunSnapshot { return this.state.snapshot(); }

  /**
   * 等待首个真实节点会话已耐久记录、因全局资源护栏实际等待，或 Run 已终结。
   *
   * daemon 只能在这之后把 running Run 交还给 CLI，避免“任务尚未安全投递”就让用户
   * 误以为可关闭启动过程。多个后续节点仍在后台按 Workflow 正常调度。
   */
  async waitForSafeLaunch(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.snapshot().status === "running" && !this.state.hasRecordedSession() && !this.host.hasWaitingStart()) {
      if (Date.now() >= deadline) throw new Error("Run 未在时限内完成首个节点会话投递。");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 供 daemon 在真实 Agent 启动前创建并注册 ControlServer；不对 Workflow 作者 API 暴露。 */
  controlContext(): { readonly journal: RunJournal; readonly state: RunStateMachine } { return this.host.controlContext(); }

  /** 为当前 Run 创建唯一 ControlServer；真实执行器须在节点启动前绑定它。 */
  createControlServer(): ControlServer {
    const context = this.controlContext();
    return new ControlServer(context.journal, context.state);
  }

  private async transitionRun(status: "completed" | "interrupted", diagnostic: string | null): Promise<void> {
    const event: JournalEvent = { type: "run.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic, status };
    await this.journal.append(event);
    this.state.apply(event);
  }
}
