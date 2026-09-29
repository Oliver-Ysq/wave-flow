export type SideEffects = "none" | "workspace";

export type WorkflowMeta = {
  name: string;
  description: string;
  phases: string[];
  sideEffects: SideEffects;
};

export type AgentOptions = {
  label?: string;
  phase?: string;
};

export type AgentResult = {
  output: string;
  replayed: boolean;
  runId: string;
};

export interface WorkflowContext {
  agent(prompt: string, options?: AgentOptions): Promise<AgentResult>;
}

export type WorkflowModule<Args = unknown, Result = unknown> = {
  meta: WorkflowMeta;
  default?: (ctx: WorkflowContext, args: Args) => Promise<Result>;
  run?: (ctx: WorkflowContext, args: Args) => Promise<Result>;
};

export type AgentExecutionInput = {
  prompt: string;
  label: string;
  cwd: string;
};

export type AgentAdapter = {
  execute(input: AgentExecutionInput): Promise<{ output: string }>;
};

export type WorkflowEvent =
  | { type: "workflow.start"; runId: string; workflow: string }
  | { type: "agent.started"; runId: string; label: string; prompt: string }
  | { type: "agent.completed"; runId: string; label: string }
  | { type: "workflow.end"; runId: string; workflow: string }
  | { type: "workflow.error"; runId: string; workflow: string; error: string };

export type EventSink = {
  emit(event: WorkflowEvent): void;
};
