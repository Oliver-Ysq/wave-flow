import type {ExecutionConfigSnapshot,ExecutionPlanResponse,ExecutionWorkspaceConfig} from "./types";
import {ViewCache} from "./workbench-state";

/** 同一页面会话的模块执行确认缓存；导航重挂载不重新生成 UUID，不跨 App 重启保存输入。 */
export class DesignConfirmationCache {
  private readonly requests=new ViewCache<{id:string;config:ExecutionConfigSnapshot|undefined}>(64);
  /** 脚本模式确认：CLI 由源码决定，配置只承载工作区授权；读类不产生配置。 */
  script(identity:string,input:Record<string,unknown>|undefined,plan:ExecutionPlanResponse,workspaces?:ExecutionWorkspaceConfig):{id:string;config:ExecutionConfigSnapshot|undefined} {
    const key=JSON.stringify({identity,input,workspaces,sceneEvidenceHash:plan.sceneEvidenceHash??null,script:true});
    const prior=this.requests.get(key);
    if(prior)return structuredClone(prior);
    const request={id:crypto.randomUUID(),config:workspaces?{version:1 as const,assignmentMode:"script" as const,createdAt:new Date().toISOString(),workspaces}:undefined};
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
