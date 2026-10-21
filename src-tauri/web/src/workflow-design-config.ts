import type {ExecutionConfigSnapshot,ExecutionPlanResponse,ExecutionWorkspaceConfig,WorkerAssignment} from "./types";
import {ViewCache} from "./workbench-state";

/** 同一页面会话的确认请求缓存；最多64份载荷，导航重挂载不重新生成UUID，不跨App重启保存输入。 */
export class DesignConfirmationCache {
  private readonly requests=new ViewCache<{id:string;config:ExecutionConfigSnapshot}>(64);
  /** 身份包含Task/card/revision；参数或CLI选择改变后生成新请求，原载荷重试复用完整冻结配置。 */
  get(identity:string,input:Record<string,unknown>|undefined,choices:Readonly<Record<string,string>>,plan:ExecutionPlanResponse,workspaces?:ExecutionWorkspaceConfig):{id:string;config:ExecutionConfigSnapshot} {
    const key=JSON.stringify({identity,input,choices,workspaces,sceneEvidenceHash:plan.sceneEvidenceHash??null});
    const prior=this.requests.get(key);
    if(prior)return structuredClone(prior);
    const request={id:crypto.randomUUID(),config:{...designExecutionConfig(plan,choices),...(workspaces?{workspaces}:{})}};
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
    const value:ExecutionWorkspaceConfig={version:3,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:plan.repository,baseCommit:plan.baseCommit,excludeExistingDirty:excludeDirty,nodes:plan.nodeIds.map(nodeId=>({nodeId}))},workspaceId,...(continuation?{continuation:{executionId:continuation.executionId,workspaceId,head:continuation.head}}:{})};
    this.requests.set(key,value);return structuredClone(value);
  }
}

/** 从已验证计划和用户选择构造执行快照；不调用模型，不修改脚本或启动执行。 */
export function designExecutionConfig(plan:ExecutionPlanResponse,choices:Readonly<Record<string,string>>,createdAt=new Date().toISOString()):ExecutionConfigSnapshot {
  const fallback=plan.harnessRuntime;
  if(!fallback)throw new Error("尚未设置已验证的 Wave Flow CLI。");
  const ids=new Set(["*",...plan.workers.map(worker=>worker.id)]);
  if(Object.keys(choices).some(id=>!ids.has(id)))throw new Error("CLI选择包含未知Worker。");
  const assignment=(id:string):WorkerAssignment=>{
    const explicit=choices[id],runtime=plan.pool.find(item=>item.runtimeId===(explicit??fallback.runtimeId));
    if(!runtime)throw new Error("CLI已不可用，请重新选择。");
    return {agentId:id,cli:runtime.cli,model:"cli-default",source:explicit?"user":"harness-cli",runtimeId:runtime.runtimeId,adapterId:runtime.verifiedAdapter.adapterId,adapterVersion:runtime.verifiedAdapter.adapterVersion};
  };
  return {version:1,createdAt,fallbackRuntimeId:fallback.runtimeId,ruleText:null,ruleDegraded:false,defaultAssignment:assignment("*"),assignments:plan.workers.map(worker=>assignment(worker.id))};
}
