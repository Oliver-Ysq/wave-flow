import type { WorkspaceAuthorization } from "./workspace-manager";
import type { WorkspaceNodeBinding } from "./workspace-executor";
import { WorkflowContractError } from "../workflow/errors";

/** 用户冻结的Git成果配置；同一Execution不可热修改，read-only默认不提供。 */
export type ExecutionWorkspaceConfig = {
  /** 独立契约版本，当前固定2；旧精确文件授权不自动升级。 */
  readonly version: 2;
  /** 明确保存整个受管worktree的授权，绑定项目基准与节点。 */
  readonly authorization: WorkspaceAuthorization;
  /** 每个写节点到workspace UUID的绑定；相同UUID表示同链顺序工作区。 */
  readonly bindings: readonly WorkspaceNodeBinding[];
};

/** 运行时形状与来源绑定验证；不执行Git，也不把静态枚举当实际依赖。 */
export function validateExecutionWorkspaces(value: unknown): ExecutionWorkspaceConfig {
  if (!plain(value) || value.version !== 2 || !plain(value.authorization) || !Array.isArray(value.bindings)) fail("Git成果配置格式无效；需要整工作区授权v2。");
  const authorization = value.authorization;
  if ("autoSquashDelivery" in authorization) fail("旧自动交付授权不支持；请重新确认整工作区授权。");
  uuid(authorization.authorizationId);
  if (typeof authorization.approvedAt !== "string" || !Number.isFinite(Date.parse(authorization.approvedAt)) || typeof authorization.repository !== "string" || !authorization.repository.startsWith("/") || typeof authorization.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authorization.baseCommit) || typeof authorization.excludeExistingDirty !== "boolean" || !Array.isArray(authorization.nodes) || !authorization.nodes.length) fail("Git成果授权字段无效。");
  const ids = new Set<string>();
  for (const node of authorization.nodes) {
    if (!plain(node) || typeof node.nodeId !== "string" || !/^[A-Za-z0-9._:/-]{1,120}$/.test(node.nodeId) || ids.has(node.nodeId) || "paths" in node) fail("Git成果节点授权无效。");
    ids.add(node.nodeId);
    if (node.externalResources !== undefined && (!Array.isArray(node.externalResources) || new Set(node.externalResources).size !== node.externalResources.length || node.externalResources.some(resource => typeof resource !== "string" || !/^[a-z0-9][a-z0-9:._/-]{0,119}$/.test(resource)))) fail("外部资源授权无效。");
  }
  const seen = new Set<string>();
  for (const binding of value.bindings) {
    if (!plain(binding) || typeof binding.nodeId !== "string" || !ids.has(binding.nodeId) || seen.has(binding.nodeId)) fail("Git成果workspace绑定无效或未授权。");
    uuid(binding.workspaceId); seen.add(binding.nodeId);
    if (binding.integrationSources !== undefined) {
      const source = binding.integrationSources;
      if (!plain(source) || Object.keys(source).length !== 1) fail("集成来源配置无效。");
      if ("nodeIds" in source) {
        if (!Array.isArray(source.nodeIds) || !source.nodeIds.length || new Set(source.nodeIds).size !== source.nodeIds.length || source.nodeIds.some(id => typeof id !== "string" || !ids.has(id) || id === binding.nodeId)) fail("集成来源缺失或成环。");
      } else if (!Number.isSafeInteger(source.batchSequence) || (source.batchSequence as number) < 1) fail("集成来源批次无效。");
    }
  }
  if (seen.size !== ids.size) fail("已授权写节点缺少workspace绑定。");
  // 固定来源图仅做环拒绝，不按源码位置预测运行依赖。动态批次由Runtime核验。
  const bindings = value.bindings as unknown as readonly WorkspaceNodeBinding[];
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) fail("集成来源成环。"); if (done.has(id)) return; visiting.add(id); const source = bindings.find(binding => binding.nodeId === id)?.integrationSources; if (source && "nodeIds" in source) source.nodeIds.forEach(visit); visiting.delete(id); done.add(id); };
  bindings.forEach(binding => visit(binding.nodeId));
  return structuredClone(value) as unknown as ExecutionWorkspaceConfig;
}
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function uuid(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail("Git成果身份必须为UUID。"); }
function fail(message: string): never { throw new WorkflowContractError(message); }
