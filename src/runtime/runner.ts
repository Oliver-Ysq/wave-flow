import type { AgentOptions, AgentResult, RuntimeOptions } from "./types";
import type { WorkflowContext, WorkflowModule } from "../workflow/types";
import { getWorkflowRun, validateMeta } from "../workflow/validation";

/**
 * Runtime 中负责执行一份 Workflow 的入口。
 * 它负责校验、注入 ctx.agent()、委派 Adapter 和记录事件；它不解释 Prompt 语义，
 * 也不直接耦合 Codex CLI，分别把这些职责留给 Workflow 与 Adapter。
 */
export class WorkflowRunner {
  /** @param options Runner 运行一次 Workflow 所需的执行器、事件输出和工作目录。 */
  constructor(private readonly options: RuntimeOptions) {}

  /**
   * @param workflow 包含静态 meta 与 default/run 入口的本地模块。
   * @param args 传入 Workflow 入口的业务参数。
   * @returns Workflow 最终返回的结果。
   * @throws meta/入口非法或 Workflow、Adapter 抛错时失败。
   */
  async run<Args, Result>(workflow: WorkflowModule<Args, Result>, args: Args): Promise<Result> {
    // 元数据失败不构成一次有效运行，因此必须在事件和 Agent 调用之前校验。
    validateMeta(workflow.meta);
    const run = getWorkflowRun(workflow);
    const runId = this.options.runId ?? crypto.randomUUID();
    const { events } = this.options;

    events.emit({ type: "workflow.start", runId, workflow: workflow.meta.name });
    try {
      const result = await run(this.createContext(runId), args);
      events.emit({ type: "workflow.end", runId, workflow: workflow.meta.name });
      return result;
    } catch (error) {
      events.emit({
        type: "workflow.error",
        runId,
        workflow: workflow.meta.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** @param runId 本次 Workflow 的唯一标识。@returns 不暴露底层依赖的受控 WorkflowContext。 */
  private createContext(runId: string): WorkflowContext {
    return {
      agent: async (prompt: string, options: AgentOptions = {}): Promise<AgentResult> => {
        const label = options.label ?? "agent";
        this.options.events.emit({ type: "agent.started", runId, label, prompt });
        const result = await this.options.adapter.execute({ prompt, label, cwd: this.options.cwd });
        this.options.events.emit({ type: "agent.completed", runId, label });
        return { output: result.output, replayed: false, runId };
      },
    };
  }
}
