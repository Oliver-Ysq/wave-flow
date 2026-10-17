import type {ExecutionConfigSnapshot,ExecutionPlanResponse,ExecutionWorkspaceConfig,WorkerAssignment} from "./types";
import {ViewCache} from "./workbench-state";

/** 同一页面会话的确认请求缓存；最多64份载荷，导航重挂载不重新生成UUID，不跨App重启保存输入。 */
export class DesignConfirmationCache {
  private readonly requests=new ViewCache<{id:string;config:ExecutionConfigSnapshot}>(64);
  /** 身份包含Task/card/revision；参数或CLI选择改变后生成新请求，原载荷重试复用完整冻结配置。 */
  get(identity:string,input:Record<string,unknown>|undefined,choices:Readonly<Record<string,string>>,plan:ExecutionPlanResponse,workspaces?:ExecutionWorkspaceConfig):{id:string;config:ExecutionConfigSnapshot} {
    const key=JSON.stringify({identity,input,choices,workspaces});
    const prior=this.requests.get(key);
    if(prior)return structuredClone(prior);
    const request={id:crypto.randomUUID(),config:{...designExecutionConfig(plan,choices),...(workspaces?{workspaces}:{})}};
    this.requests.set(key,request);
    return structuredClone(request);
  }
}

/** Git授权载荷重试缓存；仅显式选择改变或基准改变时产生新UUID，不因点击重试扩张权限。 */
export class WorkspaceConfirmationCache {
  private readonly requests=new ViewCache<ExecutionWorkspaceConfig>(64);
  get(identity:string,plan:NonNullable<ExecutionPlanResponse["workspacePlan"]>,drafts:Readonly<Record<string,{paths:string;resources:string;workspaceId:string;sources?:string;workspaceGroup?:string}>>,excludeDirty:boolean,approved:boolean):ExecutionWorkspaceConfig {
    if(!approved)throw new Error("请明确勾选授权受管成果提交。");
    if(plan.diagnostic||!plan.baseCommit)throw new Error(plan.diagnostic??"Git基准不可用。");
    if(plan.dirtyPaths.length&&!excludeDirty)throw new Error("已有dirty内容，请明确选择排除或先处理工作区。");
    const key=JSON.stringify({identity,plan,drafts,excludeDirty,approved});const prior=this.requests.get(key);if(prior)return structuredClone(prior);
    const nodes=plan.nodeIds.map(nodeId=>{const draft=drafts[nodeId];const paths=(draft?.paths??"").split("\n").map(path=>path.trim()).filter(Boolean);if(!paths.length)throw new Error(`写节点 ${nodeId} 必须填写精确成果文件路径。`);const externalResources=(draft?.resources??"").split("\n").map(path=>path.trim()).filter(Boolean);return {nodeId,paths,...(externalResources.length?{externalResources}:{})};});
    const value:ExecutionWorkspaceConfig={version:1,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:plan.repository,baseCommit:plan.baseCommit,excludeExistingDirty:excludeDirty, autoSquashDelivery: true,nodes},bindings:nodes.map(node=>{const draft=drafts[node.nodeId],sources=(draft?.sources??"").split("\n").map(id=>id.trim()).filter(Boolean);if(sources.some(id=>!plan.nodeIds.includes(id)||id===node.nodeId))throw new Error(`集成来源 ${node.nodeId} 无效。`);return {nodeId:node.nodeId,workspaceId:draft?.workspaceId??crypto.randomUUID(),...(sources.length?{integrationSources:{nodeIds:sources}}:{})};})};
    const groups=new Map<string,string>();
    for(const binding of value.bindings){const group=drafts[binding.nodeId]?.workspaceGroup?.trim()||binding.nodeId;const prior=groups.get(group);if(prior)binding.workspaceId=prior;else groups.set(group,binding.workspaceId);}
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const left=value.bindings[i]!,right=value.bindings[j]!;if(left.workspaceId===right.workspaceId||left.integrationSources||right.integrationSources)continue;if(nodes[i]!.paths.some(path=>nodes[j]!.paths.includes(path)))throw new Error("独立写分支成果路径重叠，请顺序复用工作区或声明显式集成。");}
    this.requests.set(key,value);return structuredClone(value);
  }
}

/** 从已验证计划和用户选择构造执行快照；不调用模型，不修改脚本或启动执行。 */
export function designExecutionConfig(plan:ExecutionPlanResponse,choices:Readonly<Record<string,string>>,createdAt=new Date().toISOString()):ExecutionConfigSnapshot {
  const fallback=plan.harnessRuntime;
  if(!fallback)throw new Error("尚未设置已验证主控CLI。");
  const ids=new Set(["*",...plan.workers.map(worker=>worker.id)]);
  if(Object.keys(choices).some(id=>!ids.has(id)))throw new Error("CLI选择包含未知Worker。");
  const assignment=(id:string):WorkerAssignment=>{
    const explicit=choices[id],runtime=plan.pool.find(item=>item.runtimeId===(explicit??fallback.runtimeId));
    if(!runtime)throw new Error("CLI已不可用，请重新选择。");
    return {agentId:id,cli:runtime.cli,model:"cli-default",source:explicit?"user":"harness-cli",runtimeId:runtime.runtimeId,adapterId:runtime.verifiedAdapter.adapterId,adapterVersion:runtime.verifiedAdapter.adapterVersion};
  };
  return {version:1,createdAt,fallbackRuntimeId:fallback.runtimeId,ruleText:null,ruleDegraded:false,defaultAssignment:assignment("*"),assignments:plan.workers.map(worker=>assignment(worker.id))};
}
