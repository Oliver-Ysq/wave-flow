import type { WorkspaceAuthorization } from "./workspace-manager";
import { WorkflowContractError } from "../workflow/errors";

/** 用户冻结的Git成果配置；一次Execution只使用一个受管worktree，全部写节点共享。 */
export type ExecutionWorkspaceConfig = {
  /** 独立契约版本，当前固定3；v2每节点工作区/集成来源不自动升级。 */
  readonly version: 3;
  /** 明确保存整个受管worktree的授权，绑定项目基准与写节点。 */
  readonly authorization: WorkspaceAuthorization;
  /** 本Execution唯一受管worktree UUID；并行写节点共享同一目录。 */
  readonly workspaceId: string;
  /** 显式续作的原Execution与交接HEAD；缺省为首次分配，不复制旧节点完成状态。 */
  readonly continuation?: {
    /** 同Task前一终态Execution，Engine核验归属；不是授权秘密。 */
    readonly executionId: string;
    /** 被接续的持续worktree；必须与本次workspaceId一致。 */
    readonly workspaceId: string;
    /** 交接时worktree的权威HEAD；漂移拒绝，不回滚。 */
    readonly head: string;
  };
};

/** 旧版（v1/v2 逐节点工作区）记录的显式拒绝：不自动升级，也不让内部断言（如 UUID 校验）泄漏成晦涩错误。 */
export function assertCurrentWorkspaceRecord(workspaces: unknown): asserts workspaces is ExecutionWorkspaceConfig {
  if (!plain(workspaces) || workspaces.version !== 3) fail("原执行为旧版逐节点工作区授权（v1/v2），不自动升级；请归档该任务后在新任务中继续，旧现场不再支持续作、恢复、应用或清理。");
}

/** 运行时形状与来源绑定验证；不执行Git，也不把静态枚举当实际依赖。 */
export function validateExecutionWorkspaces(value: unknown): ExecutionWorkspaceConfig {
  if (!plain(value) || value.version !== 3 || !plain(value.authorization)) fail("Git成果配置格式无效；需要整工作区授权v3。");
  const authorization = value.authorization;
  if ("autoSquashDelivery" in authorization) fail("旧自动交付授权不支持；请重新确认整工作区授权。");
  uuid(value.workspaceId);
  uuid(authorization.authorizationId);
  if (typeof authorization.approvedAt !== "string" || !Number.isFinite(Date.parse(authorization.approvedAt)) || typeof authorization.repository !== "string" || !authorization.repository.startsWith("/") || typeof authorization.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authorization.baseCommit) || typeof authorization.excludeExistingDirty !== "boolean" || !Array.isArray(authorization.nodes) || !authorization.nodes.length) fail("Git成果授权字段无效。");
  const ids = new Set<string>();
  for (const node of authorization.nodes) {
    if (!plain(node) || typeof node.nodeId !== "string" || !/^[A-Za-z0-9._:/-]{1,120}$/.test(node.nodeId) || ids.has(node.nodeId) || "paths" in node || "externalResources" in node) fail("Git成果节点授权无效。");
    ids.add(node.nodeId);
  }
  if (value.continuation !== undefined) {
    const prior = value.continuation;
    if (!plain(prior) || Object.keys(prior).some(key => !["executionId", "workspaceId", "head"].includes(key))) fail("续作来源字段无效。");
    uuid(prior.executionId); uuid(prior.workspaceId);
    if (prior.workspaceId !== value.workspaceId) fail("续作必须接续本次唯一受管worktree。");
    if (typeof prior.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(prior.head)) fail("续作HEAD无效。");
  }
  return structuredClone(value) as unknown as ExecutionWorkspaceConfig;
}
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function uuid(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/.test(value)) fail("Git成果身份必须为UUID。"); }
function fail(message: string): never { throw new WorkflowContractError(message); }
