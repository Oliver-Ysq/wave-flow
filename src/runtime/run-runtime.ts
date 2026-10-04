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

/** 创建一次耐久 Run 所需的公开配置。 */
export type CreateRunOptions = {
  /** 受信任、已加载的 Workflow 模块。 */
  readonly workflow: WorkflowModule<JsonObject, unknown>;
  /** 本次 Workflow JSON-safe 输入。 */
  readonly input: JsonObject;
  /** Workflow 主文件内容；用于生成本次 Manifest 的 hash。 */
  readonly workflowSource: string;
  /** 项目 cwd；默认当前进程目录。 */
  readonly cwd?: string;
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
    const cwd = await realpath(options.cwd ?? process.cwd());
    const manifest: RunManifest = {
      runId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: options.workflow.meta,
      workflowHash: createHash("sha256").update(options.workflowSource).digest("hex"), cwd, input: options.input, createdAt: new Date().toISOString(),
    };
    const journal = await RunJournal.create(manifest, runsRoot(cwd));
    const state = new RunStateMachine(manifest);
    state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    return new RunRuntime(journal, state, new RunRuntimeHost(journal, state, options.executor));
  }

  /** 打开已有 Run 并从已验证 Journal 事实重建 Phase → Agent 查询视图。 */
  static async open(runId: string, cwd: string, executor: AgentNodeExecutor): Promise<RunRuntime> {
    const opened = await RunJournal.open(runId, runsRoot(await realpath(cwd)));
    const state = new RunStateMachine(opened.journal.manifest);
    for (const event of opened.events) state.apply(event);
    const sequence = state.snapshot().phases.flatMap((phase) => phase.agents).length;
    return new RunRuntime(opened.journal, state, new RunRuntimeHost(opened.journal, state, executor, sequence));
  }

  /** 执行 Workflow；完成后以 durable run.status 事实封存聚合状态。 */
  async run(workflow: WorkflowModule<JsonObject, unknown>): Promise<unknown> {
    try {
      const result = await executeWorkflow(workflow, this.journal.manifest.input, this.host, { cwd: this.journal.manifest.cwd });
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

  private async transitionRun(status: "completed" | "interrupted", diagnostic: string | null): Promise<void> {
    const event: JournalEvent = { type: "run.status", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic, status };
    await this.journal.append(event);
    this.state.apply(event);
  }
}
