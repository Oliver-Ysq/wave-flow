import type { AgentNodeSnapshot } from "../runtime/run-types";
import { WorkflowContractError } from "../workflow/errors";
import { GitRepository } from "./git-repository";
import type { WorkspaceNodeBinding } from "./workspace-executor";
import type { WorkspaceManager } from "./workspace-manager";

/** Engine执行配置中的明确集成来源；不是作者agent参数，不猜测AST/Prompt依赖。 */
export type IntegrationSourceSelection =
  | { /** 固定来源集合，非空、有序且唯一。 */ readonly nodeIds: readonly string[] }
  | { /** 同一Run当前attempt内已创建的完整并行批次号；缺失或未结束立即拒绝。 */ readonly batchSequence: number };

/** 经Runtime与Git双重核验的成果引用；供普通ACP集成Worker使用，与业务input分开。 */
export type IntegrationCommitContext = {
  /** 原Run身份，不允许跨任务引入成果。 */
  readonly runId: string;
  /** 原来源逻辑节点，不是模型生成标签。 */
  readonly nodeId: string;
  /** 来源业务attempt。 */
  readonly attempt: number;
  /** 来源受管workspace身份。 */
  readonly workspaceId: string;
  /** 共用Git元数据身份；集成目标必须属于同一仓库。 */
  readonly commonDirectory: string;
  /** 已保存、实际核验的成果commit。 */
  readonly commit: string;
  /** 原用户授权下实际提交的文件，不等于业务验收通过。 */
  readonly paths: readonly string[];
};

/** 核对本次调用前已经创建并completed的完整来源，不等待未来节点或制造隐藏依赖。 */
export async function resolveIntegrationSources(options: {
  /** 原Run身份，由Engine/Runtime提供。 */ readonly runId: string;
  /** 当前即将创建真实writer的集成节点。 */ readonly integrationNode: AgentNodeSnapshot;
  /** 当前原Runtime节点投影；不复制Store，不按工作区结果猜业务状态。 */ readonly nodes: readonly AgentNodeSnapshot[];
  /** 用户冻结的来源选择。 */ readonly selection: IntegrationSourceSelection;
  /** 用户冻结的节点workspace绑定。 */ readonly bindings: readonly WorkspaceNodeBinding[];
  /** 唯一受管成果管理器。 */ readonly manager: WorkspaceManager;
  /** 集成目标Git身份，不允许从另一repo导入commit。 */ readonly targetCommonDirectory: string;
}): Promise<readonly IntegrationCommitContext[]> {
  const { selection, integrationNode: target } = options;
  let ids: readonly string[];
  if ("nodeIds" in selection) {
    ids = selection.nodeIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail("集成来源必须为非空唯一节点集合。");
  } else {
    if (!Number.isSafeInteger(selection.batchSequence) || selection.batchSequence < 1) fail("集成来源批次号无效。");
    const batch = options.nodes.filter(node => node.executionAttemptId === target.executionAttemptId && node.executionBatch.sequence === selection.batchSequence);
    if (!batch.length || batch.some(node => node.executionBatch.mode !== "parallel")) fail("集成来源完整并行批次不存在。");
    ids = batch.map(node => node.id);
  }
  const contexts: IntegrationCommitContext[] = [];
  for (const id of ids) {
    const node = options.nodes.find(node => node.id === id);
    if (!node || id === target.id || node.sequence >= target.sequence || node.status !== "completed" || node.sandbox !== "workspace-write") fail(`集成来源 ${id} 未在本调用前完成写入；拒绝未来来源、环或partial结果。`);
    const binding = options.bindings.find(item => item.nodeId === id);
    if (!binding) fail(`集成来源 ${id} 没有受管workspace绑定。`);
    const workspace = await options.manager.inspect(binding.workspaceId);
    if (workspace.lease || workspace.commonDirectory !== options.targetCommonDirectory) fail(`集成来源 ${id} 仍有writer锁或仓库身份不匹配。`);
    const result = workspace.results.findLast(result => result.runId === options.runId && result.nodeId === id && result.attempt === node.executionAttemptId);
    if (!result?.ready) fail(`集成来源 ${id} 成果未ready，不能用业务completed代替Git交付。`);
    const allowed = workspace.authorization.nodes.find(item => item.nodeId === id);
    if (!allowed) fail(`集成来源 ${id} 超出原提交授权。`);
    const repo = await GitRepository.open(workspace.cleanedAt?workspace.authorization.repository:workspace.cwd);
    if (repo.commonDirectory !== workspace.commonDirectory) fail("集成来源Git仓库身份漂移。");
    await repo.verifyCommitObject(result.commit,result.startCommit,result.paths);
    if(!workspace.cleanedAt){const latest=workspace.results.at(-1),state=await repo.inspect();if(!latest?.ready||state.head!==latest.commit||state.changedPaths.length||state.conflicts.length)fail("集成来源持续worktree现场漂移或未收尾。");}
    contexts.push({ runId: options.runId, nodeId: id, attempt: node.executionAttemptId, workspaceId: binding.workspaceId, commonDirectory: workspace.commonDirectory, commit: result.commit, paths: result.paths });
  }
  return contexts;
}
function fail(message: string): never { throw new WorkflowContractError(message); }
