import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkflowExecutionHost } from "../runtime/workflow-host";
import type { WorkflowMeta } from "../shared/workflow-types";
import { WorkflowContractError } from "./errors";

/** 每一次 Workflow Run 的进程内作者 API 状态；不跨进程或持久化。 */
export type WorkflowExecutionContext = {
  /** 当前 Run 已验证的静态 meta，用于 phase() 精确匹配。 */
  readonly meta: WorkflowMeta;
  /** Runtime 注入的最小委派宿主；本层不创建 CLI、会话或 Journal。 */
  readonly host: WorkflowExecutionHost;
  /** 本次 Run 的 canonical 项目 cwd；Agent cwd 只能是此目录或其子目录。 */
  readonly cwd: string;
  /** 已使用 Agent id，确保同一 Run 的稳定节点身份不重复。 */
  readonly agentIds: Set<string>;
  /** 本次 Run 是否仍在执行；入口返回后关闭，阻止遗留异步回调继续委派宿主。 */
  readonly lifecycle: { active: boolean };
  /** 当前共享阶段；未调用 phase() 前为 undefined。 */
  currentPhase: string | undefined;
  /** 大于零表示正在并发 thunk 或 pipeline stage 中，禁止切换共享阶段。 */
  concurrentDepth: number;
  /** 已开始但作者尚未 await 的 Agent 操作；Workflow 返回前必须完成，避免 Run 过早封存。 */
  readonly pendingOperations: Set<Promise<unknown>>;
};

const storage = new AsyncLocalStorage<WorkflowExecutionContext>();

/** 在独立异步上下文内执行一次 Workflow，确保并行 Run 不共享作者 API 状态。 */
export function runWithWorkflowContext<Result>(meta: WorkflowMeta, host: WorkflowExecutionHost, cwd: string, callback: () => Promise<Result>): Promise<Result> {
  return storage.run({ meta, host, cwd, agentIds: new Set(), lifecycle: { active: true }, currentPhase: undefined, concurrentDepth: 0, pendingOperations: new Set() }, callback);
}

/** 登记一个 Agent 操作；即使作者未 await，Workflow 入口也会在结束前等待它完成。 */
export function trackWorkflowOperation<T>(operation: Promise<T>): Promise<T> {
  const context = requireWorkflowContext();
  context.pendingOperations.add(operation);
  void operation.finally(() => context.pendingOperations.delete(operation)).catch(() => undefined);
  return operation;
}

/** 等待当前 Run 中所有已启动 Agent 操作；拒绝会向 Workflow 顶层传播。 */
export async function waitForWorkflowOperations(): Promise<void> {
  const context = requireWorkflowContext();
  while (context.pendingOperations.size > 0) await Promise.all([...context.pendingOperations]);
}

/** 取得当前 Workflow 上下文；作者 API 在 Workflow 外调用时必须拒绝。 */
export function requireWorkflowContext(): WorkflowExecutionContext {
  const context = storage.getStore();
  if (!context) throw new WorkflowContractError("Workflow 作者 API 只能在正在执行的 Workflow 内调用。");
  if (!context.lifecycle.active) throw new WorkflowContractError("Workflow 作者 API 不能在 Workflow 结束后调用。");
  return context;
}

/** 关闭当前 Run 的作者 API；已派生异步上下文共享此生命周期标记并会 fail closed。 */
export function closeWorkflowContext(): void {
  requireWorkflowContext().lifecycle.active = false;
}

/** 在派生 Store 中执行并发任务，使其创建的异步后代始终保留禁止 phase() 的标记。 */
export function runInConcurrentWorkflowScope<Result>(callback: () => Promise<Result>): Promise<Result> {
  const context = requireWorkflowContext();
  return storage.run({
    ...context,
    currentPhase: context.currentPhase,
    concurrentDepth: context.concurrentDepth + 1,
  }, callback);
}
