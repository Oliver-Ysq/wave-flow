import type {ExecutionConfigSnapshot,ExecutionPlanResponse,WorkerAssignment} from "./types";
import {ViewCache} from "./workbench-state";

/** 同一页面会话的确认请求缓存；最多64份载荷，导航重挂载不重新生成UUID，不跨App重启保存输入。 */
export class DesignConfirmationCache {
  private readonly requests=new ViewCache<{id:string;config:ExecutionConfigSnapshot}>(64);
  /** 身份包含Task/card/revision；参数或CLI选择改变后生成新请求，原载荷重试复用完整冻结配置。 */
  get(identity:string,input:Record<string,unknown>|undefined,choices:Readonly<Record<string,string>>,plan:ExecutionPlanResponse):{id:string;config:ExecutionConfigSnapshot} {
    const key=JSON.stringify({identity,input,choices});
    const prior=this.requests.get(key);
    if(prior)return structuredClone(prior);
    const request={id:crypto.randomUUID(),config:designExecutionConfig(plan,choices)};
    this.requests.set(key,request);
    return structuredClone(request);
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
