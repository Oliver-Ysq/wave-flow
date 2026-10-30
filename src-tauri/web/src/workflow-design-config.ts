import type {ExecutionConfigSnapshot,ExecutionPlanResponse,ExecutionWorkspaceConfig,RuntimeCli} from "./types";
import {ViewCache} from "./workbench-state";

/** 同一页面会话的模块执行确认缓存；导航重挂载不重新生成 UUID，不跨 App 重启保存输入。 */
export class DesignConfirmationCache {
  private readonly requests=new ViewCache<{id:string;config:ExecutionConfigSnapshot|undefined}>(64);
  /**
   * 脚本模式确认：配置承载逐节点 CLI 选择与（写类）工作区授权。
   *
   * `nodeClis` 只对源码中省略 `cli` 的字面量节点生效，每个节点各自选择；`cli` 只作为
   * 动态节点的兜底。全部为空时不产生配置（节点都自带 CLI 的历史路径）。
   */
  script(identity:string,input:Record<string,unknown>|undefined,plan:ExecutionPlanResponse,workspaces?:ExecutionWorkspaceConfig,cli?:RuntimeCli|null,nodeClis?:Record<string,RuntimeCli>|null):{id:string;config:ExecutionConfigSnapshot|undefined} {
    const nodes=nodeClis&&Object.keys(nodeClis).length>0?nodeClis:undefined;
    const key=JSON.stringify({identity,input,workspaces,cli:cli??null,nodes:nodes??null,sceneEvidenceHash:plan.sceneEvidenceHash??null,script:true});
    const prior=this.requests.get(key);
    if(prior)return structuredClone(prior);
    const config=workspaces||cli||nodes?{version:1 as const,assignmentMode:"script" as const,createdAt:new Date().toISOString(),...(cli?{cli}:{}),...(nodes?{nodeClis:nodes}:{}),...(workspaces?{workspaces}:{})}:undefined;
    const request={id:crypto.randomUUID(),config};
    this.requests.set(key,request);
    return structuredClone(request);
  }
}

/** Git授权载荷重试缓存；基准或续作现场改变时产生新UUID，不因点击重试扩张权限。 */
export class WorkspaceConfirmationCache {
  private readonly requests=new ViewCache<ExecutionWorkspaceConfig>(64);
  get(identity:string,plan:NonNullable<ExecutionPlanResponse["workspacePlan"]>,excludeDirty:boolean,continuation?:ExecutionPlanResponse["continuationPlan"]):ExecutionWorkspaceConfig {
    if(plan.diagnostic||!plan.baseCommit)throw new Error(plan.diagnostic??"Git基准不可用。");
    if(plan.dirtyPaths.length&&!excludeDirty)throw new Error("已有dirty内容，请明确选择排除或先处理工作区。");
    const key=JSON.stringify({identity,plan,excludeDirty,continuation});const prior=this.requests.get(key);if(prior)return structuredClone(prior);
    // 一个Execution只有一个共享worktree；写修订自动接续原现场，不提供分组或集成来源。
    const workspaceId=continuation?.workspaceId??crypto.randomUUID();
    const dynamicNodes=plan.dynamicNodePrefixes?.length?plan.dynamicNodePrefixes.map(nodeIdPrefix=>({nodeIdPrefix})):undefined;
    const value:ExecutionWorkspaceConfig={version:3,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:plan.repository,baseCommit:plan.baseCommit,excludeExistingDirty:excludeDirty,nodes:plan.nodeIds.map(nodeId=>({nodeId})),...(dynamicNodes?{dynamicNodes}:{})},workspaceId,...(continuation?{continuation:{executionId:continuation.executionId,workspaceId,head:continuation.head}}:{})};
    this.requests.set(key,value);return structuredClone(value);
  }
}
