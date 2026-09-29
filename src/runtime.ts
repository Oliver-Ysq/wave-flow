import {
  type AgentAdapter,
  type AgentOptions,
  type AgentResult,
  type EventSink,
  type WorkflowContext,
  type WorkflowModule,
} from "./types";
import { getWorkflowRun, validateMeta } from "./validation";

export type RuntimeOptions = {
  adapter: AgentAdapter;
  events: EventSink;
  cwd: string;
  runId?: string;
};

export class WorkflowRuntime {
  constructor(private readonly options: RuntimeOptions) {}

  async run<Args, Result>(
    workflow: WorkflowModule<Args, Result>,
    args: Args,
  ): Promise<Result> {
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

  private createContext(runId: string): WorkflowContext {
    return {
      agent: async (prompt: string, options: AgentOptions = {}): Promise<AgentResult> => {
        const label = options.label ?? "agent";
        this.options.events.emit({ type: "agent.started", runId, label, prompt });
        const result = await this.options.adapter.execute({
          prompt,
          label,
          cwd: this.options.cwd,
        });
        this.options.events.emit({ type: "agent.completed", runId, label });
        return { output: result.output, replayed: false, runId };
      },
    };
  }
}
