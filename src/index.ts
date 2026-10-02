/** Workflow 作者可导入的公开编排原语；每个函数仅可在 executeWorkflow() 建立的运行上下文内调用。 */
export { agent, log, parallel, phase, pipeline } from "./workflow/author-api";

/** 供 Runtime 或测试加载受信任本地 Workflow 的模块加载器。 */
export { loadWorkflow } from "./workflow/load-workflow";

/** 供 Runtime 将已加载 Workflow 绑定到独立异步执行上下文的执行入口。 */
export { executeWorkflow } from "./workflow/execute-workflow";
export type { WorkflowExecutionOptions } from "./workflow/execute-workflow";
export type { WorkflowExecutionHost } from "./runtime/workflow-host";
export type { CreateSessionOptions, DestroyResult, SessionBackend, SessionIdentity, SessionLiveness } from "./sessions/types";
export { CodexInteractiveAdapter } from "./adapters/codex-interactive-adapter";
export type { CodexInteractiveStartRequest } from "./adapters/codex-interactive-adapter";
export type { InteractiveCliAdapter, InteractiveCliLaunchPlan, InteractiveCliStartRequest, PromptReadyEvidence, PromptSubmissionEvidence } from "./adapters/interactive-cli-adapter";
export { InteractiveCliBootstrap, InteractiveCliBootstrapError } from "./sessions/bootstrap/interactive-cli-bootstrap";
export type { BootstrappedInteractiveSession } from "./sessions/bootstrap/interactive-cli-bootstrap";
export { RunRuntime } from "./runtime/run-runtime";
export type { CreateRunOptions } from "./runtime/run-runtime";
export type { AgentNodeExecutor, AgentNodeSnapshot, AgentNodeStatus, PhaseSnapshot, RunSnapshot, RunStatus } from "./runtime/run-types";

/** Workflow 作者与 Runtime 集成可使用的公开类型。 */
export type {
  AgentCli,
  AgentOptions,
  AgentSandbox,
  JsonSchema,
  NormalizedAgentRequest,
  PipelineStage,
  WorkflowMeta,
  WorkflowModule,
  WorkflowPhase,
} from "./shared/workflow-types";
export type { JsonObject, JsonPrimitive, JsonValue } from "./shared/json";
