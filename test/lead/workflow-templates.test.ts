import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {LeadService} from "../../src/lead/service";
import {defineTemplate,isTemplateOrigin,listWorkflowTemplates,validateTemplateInput,canonicalJson} from "../../src/lead/workflow-templates";
import {loadWorkflowSource} from "../../src/workflow/load-workflow";
import {LeadJournal} from "../../src/lead/journal";
const roots:string[]=[];
const templateDir=join(dirname(fileURLToPath(import.meta.url)),"../../src/lead/templates");
test("已开始的迟到参数提案在用户中止后零落盘，随后可显式新回合整理",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-guidance-late-proposal-"));roots.push(root);
 const state=join(root,"state");let release!:()=>void,finished!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 const done=new Promise<void>(resolve=>{finished=resolve;});
 let lateError="";
 const service=new LeadService(state,async(_id,_cwd,_prior,actions)=>({isRunning:true,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{
   await wait;
   try{await actions.proposeWorkflowRevision("","迟到整理","只读",{baseRevision:1,input:{target:"old",focus:["安全"],maxFindings:2}});}catch(error){lateError=String(error);}finally{finished();}
   return "迟到回答";
 }}));
 const template=listWorkflowTemplates()[0]!;
 const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src",focus:["安全"],maxFindings:2}};
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"延迟",template:selection});
 await service.send(task.leadRunId,"等待后整理参数");
 await service.abort(task.leadRunId);
 release();await done;
 await Bun.sleep(10);
 expect(lateError).toContain("当前主控回合");
 const snapshot=await service.snapshot(task.leadRunId);
 expect(snapshot.workflowRevisions).toEqual(task.workflowRevisions);expect(snapshot.executions).toHaveLength(0);
 await service.sendAndAwait(task.leadRunId,"明确继续");
 // 同一夹具在明确新回合提出参数才允许；旧中断回合没有污染版本。
 expect((await service.snapshot(task.leadRunId)).workflowRevisions).toHaveLength(2);
 service.close();
});
test("引导回合延迟后超时不丢参数、不自动重发；显式新对话才可继续整理",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-guidance-timeout-"));roots.push(root);
 const state=join(root,"state");let prompts=0,rejectPrompt!:(error:Error)=>void;
 const waiting=new Promise<string>((_resolve,reject)=>{rejectPrompt=reject;});
 const factory=async(_id:string,_cwd:string,_prior:unknown,actions:import("../../src/lead/action-tools").LeadActionCallbacks)=>({isRunning:true,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{
   prompts++;if(prompts===1)return waiting;
   await actions.proposeWorkflowRevision("","只读审查","仅src",{baseRevision:1,input:{target:"src",focus:["安全"],maxFindings:2}});return "已整理";
 }});
 const service=new LeadService(state,factory),template=listWorkflowTemplates()[0]!;
 const request={projectId:"project",clientRequestId:crypto.randomUUID(),text:"引导",template:{id:template.id,version:template.version,sourceHash:template.sourceHash,input:{focus:["安全"],maxFindings:2},needsGuidance:true}};
 const task=await service.startTask(root,request);
 expect(task.status).toBe("running");expect(task.workflowRevisions[0]!.input).toEqual(request.template.input);
 await service.startTask(root,request);expect(prompts).toBe(1);
 await expect(service.saveTemplate(task.leadRunId,crypto.randomUUID(),{...request.template,needsGuidance:false,input:{target:"src",focus:["安全"],maxFindings:2}},task.workflowRevisions[0]!.cardId,undefined,1)).rejects.toThrow("空闲");
 rejectPrompt(Error("测试服务请求超时"));
 for(let n=0;n<100;n++){if((await service.snapshot(task.leadRunId)).status==="interrupted")break;await Bun.sleep(5);}
 const failed=await service.snapshot(task.leadRunId);
 expect(failed.status).toBe("interrupted");expect(failed.diagnostic).toContain("请求超时");expect(failed.workflowRevisions).toEqual(task.workflowRevisions);expect(failed.executions).toHaveLength(0);
 await service.retryInitialization(task.leadRunId);expect(prompts).toBe(1);
 await service.sendAndAwait(task.leadRunId,"明确继续参数准备：范围为src");
 const next=await service.snapshot(task.leadRunId);
 expect(next.status).toBe("idle");expect(next.workflowRevisions).toHaveLength(2);expect(next.workflowRevisions[1]!.input?.target).toBe("src");expect(next.executions).toHaveLength(0);expect(prompts).toBe(2);
 service.close();
});
test("编辑候选的引导初始化重试读取原保存事实，不重建或丢失基础版本指纹",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-guidance-edit-retry-"));roots.push(root);
 const state=join(root,"state");let prompts=0,fail=true;
 const factory=async()=>{if(fail)throw Error("初始化失败");return {isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{prompts++;return "请提供审查范围";}};};
 const service=new LeadService(state,factory),template=listWorkflowTemplates()[0]!;
 const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src",focus:["安全"],maxFindings:2}};
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"编辑引导",template:selection});
 const requestId=crypto.randomUUID();
 const saved=await service.prepareTemplate(task.leadRunId,requestId,{...selection,input:{focus:["安全"],maxFindings:2},needsGuidance:true},task.workflowRevisions[0]!.cardId,1);
 expect(saved.diagnostic).toContain("启动失败");expect(saved.workflowRevisions).toHaveLength(2);
 fail=false;
 const reopened=new LeadService(state,factory);
 await reopened.retryInitialization(task.leadRunId);
 for(let n=0;n<100;n++){if((await reopened.snapshot(task.leadRunId)).status==="idle")break;await Bun.sleep(5);}
 await reopened.retryInitialization(task.leadRunId);
 expect(prompts).toBe(1);
 expect((await reopened.snapshot(task.leadRunId)).workflowRevisions).toEqual(saved.workflowRevisions);
 expect((await LeadJournal.open(task.leadRunId,state)).events.filter(event=>event.type==="lead.turn_started"&&event.userMessageId===`template-guidance:${requestId}`)).toHaveLength(1);
 service.close();reopened.close();
});
test("参数保存绑定基础版本，迟到编辑零落盘；同请求重试仍读原版本",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-parameter-base-"));roots.push(root);
 const state=join(root,"state"),service=new LeadService(state,async()=>{throw Error("不启动模型");});
 const template=listWorkflowTemplates()[0]!,selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2}};
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"编辑",template:selection});
 const card=task.workflowRevisions[0]!.cardId,requestId=crypto.randomUUID();
 await service.saveTemplate(task.leadRunId,requestId,{...selection,input:{...selection.input,target:"test/"}},card,undefined,1);
 const before=(await LeadJournal.open(task.leadRunId,state)).events.length;
 await expect(service.saveTemplate(task.leadRunId,crypto.randomUUID(),selection,card,undefined,1)).rejects.toThrow("版本已更新");
 expect((await LeadJournal.open(task.leadRunId,state)).events).toHaveLength(before);
 expect((await service.saveTemplate(task.leadRunId,requestId,{...selection,input:{...selection.input,target:"test/"}},card,undefined,1)).workflowRevisions).toHaveLength(2);
 await expect(service.saveTemplate(task.leadRunId,requestId,{...selection,input:{...selection.input,target:"test/"}},card,undefined,2)).rejects.toThrow("载荷冲突");
});
test("参数引导保存与发起同一事务，响应重试/重开不重复提问，未启动可重试",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-guidance-once-"));roots.push(root);
 const state=join(root,"state");let prompts=0,fail=true;
 const factory=async()=>{if(fail)throw Error("启动夹具失败");return {isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{prompts++;return "请提供审查范围";}};};
 const service=new LeadService(state,factory),template=listWorkflowTemplates()[0]!;
 const request={projectId:"project",clientRequestId:crypto.randomUUID(),text:"引导准备",template:{id:template.id,version:template.version,sourceHash:template.sourceHash,input:{},needsGuidance:true}};
 const failed=await service.startTask(root,request);expect(failed.diagnostic).toContain("主控启动失败");expect(prompts).toBe(0);
 fail=false;
 const [a,b]=await Promise.all([service.retryInitialization(failed.leadRunId),service.startTask(root,request)]);
 expect(a.leadRunId).toBe(b.leadRunId);
 for(let n=0;n<100;n++){if((await service.snapshot(a.leadRunId)).status==="idle")break;await Bun.sleep(5);}
 expect(prompts).toBe(1);
 const reopened=new LeadService(state,factory);
 const recovered=await reopened.startTask(root,request);
 expect(prompts).toBe(1);expect(recovered.workflowRevisions).toHaveLength(1);
 const events=(await LeadJournal.open(a.leadRunId,state)).events;
 expect(events.filter(event=>event.type==="lead.turn_started"&&event.userMessageId===`template-guidance:${request.clientRequestId}`)).toHaveLength(1);
 service.close();reopened.close();
});
test("引导候选可耐久未补齐输入但不能批准，直接完整参数保存恢复资格",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-template-guidance-"));roots.push(root);
 const service=new LeadService(join(root,"state"),async()=>{throw Error("保存不初始化模型");});
 const template=listWorkflowTemplates()[0]!;
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"引导准备",template:{id:template.id,version:template.version,sourceHash:template.sourceHash,input:{},needsGuidance:true}});
 expect(task.workflowRevisions[0]!.parametersPending).toBe(true);expect(task.executions).toHaveLength(0);
 await expect(service.acceptWorkflowRevision(task.leadRunId,1)).rejects.toThrow("未补齐");
 const next=await service.saveTemplate(task.leadRunId,crypto.randomUUID(),{id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2}},task.workflowRevisions[0]!.cardId);
 expect(next.workflowRevisions[1]!.parametersPending).toBeUndefined();expect(next.workflowRevisions[1]!.acceptedAt).toBeNull();
});
test("来源快照必须具有合法meta、稳定模板ID及非空说明",()=>{
 const {source,...origin}=listWorkflowTemplates()[0]!;
 expect(isTemplateOrigin(origin)).toBe(true);
 expect(isTemplateOrigin({...origin,id:"https://example.com/template"})).toBe(false);
 expect(isTemplateOrigin({...origin,explanation:" "})).toBe(false);
 expect(isTemplateOrigin({...origin,meta:{...origin.meta,phases:[{title:"重复"},{title:"重复"}]}})).toBe(false);
 expect(isTemplateOrigin({...origin,meta:{...origin.meta,name:"Invalid Name"}})).toBe(false);
});
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test("目录真实编译、快照隔离与输入校验不填默认、不抹空串/null",()=>{
 const template=listWorkflowTemplates()[0]!;
 const input={target:"src/",focus:["安全"],maxFindings:2,context:""};
 validateTemplateInput(template.inputSchema,input);expect(input.context).toBe("");
 validateTemplateInput(template.inputSchema,{...input,context:null});
 expect(()=>validateTemplateInput(template.inputSchema,{target:"src/"})).toThrow("参数无效");
 expect(()=>validateTemplateInput(template.inputSchema,{...input,focus:[]})).toThrow();
 expect(canonicalJson({a:1,b:2})).toBe(canonicalJson({b:2,a:1}));
 (template.inputSchema as Record<string,unknown>).type="string";
 expect(listWorkflowTemplates()[0]!.inputSchema.type).toBe("object");
});
test("内置预置以文件维护：内嵌源码与磁盘文件一致，且目录文件全部注册",async()=>{
 const files=(await readdir(templateDir)).filter(name=>name.endsWith(".ts")&&!name.endsWith(".d.ts")).sort();
 expect(files.length).toBe(listWorkflowTemplates().length);
 for(const template of listWorkflowTemplates()){
  const path=join(templateDir,`${template.id}.ts`);
  expect(files).toContain(`${template.id}.ts`);
  // 内嵌文本与磁盘文件必须逐字节一致，否则模板指纹与实际审阅到的脚本会分叉。
  expect(await readFile(path,"utf8")).toBe(template.source);
  // 文件本体必须独立通过受限编译门禁，不依赖目录注册时的副作用。
  const module=await loadWorkflowSource(template.source);
  expect(module.meta.name).toBe(template.meta.name);
  expect(module.meta.phases.map(phase=>phase.title)).toEqual(template.meta.phases.map(phase=>phase.title));
 }
});
test("深度调研模板：编译合法、Schema 边界与参数校验生效",()=>{
 const templates=listWorkflowTemplates();
 expect(templates.map(item=>item.id)).toEqual(["code-review","deep-research","deep-cr"]);
 const research=templates.find(item=>item.id==="deep-research")!;
 expect(research.version).toBe(4);expect(research.meta.name).toBe("deep-research");
 expect(research.meta.phases.map(phase=>phase.title)).toEqual(["计划","调研","核验","交叉检查与补证","综评","批判","定稿"]);
 expect(isTemplateOrigin((({source,...origin})=>origin)(research))).toBe(true);
 validateTemplateInput(research.inputSchema,{topic:"端侧推理框架选型"});
 validateTemplateInput(research.inputSchema,{topic:"t",questions:["a"],context:"",depth:"deep",language:"中文"});
 validateTemplateInput(research.inputSchema,{topic:"t",depth:"standard"});
 expect(()=>validateTemplateInput(research.inputSchema,{})).toThrow("参数无效");
 expect(()=>validateTemplateInput(research.inputSchema,{topic:"",depth:"deep"})).toThrow("参数无效");
 expect(()=>validateTemplateInput(research.inputSchema,{topic:"t",depth:"deeper"})).toThrow("参数无效");
 expect(()=>validateTemplateInput(research.inputSchema,{topic:"t",questions:[]})).toThrow("参数无效");
 expect(()=>validateTemplateInput(research.inputSchema,{topic:"t",extra:1})).toThrow("参数无效");
});
test("深度CR模板：编译合法、Schema 边界与参数校验生效",()=>{
 const review=listWorkflowTemplates().find(item=>item.id==="deep-cr")!;
 expect(review.version).toBe(5);
 expect(review.meta.phases.map(phase=>phase.title)).toEqual(["摸底","分维审查","取证复核","交叉裁决","盲区扫描","定稿汇总"]);
 expect(isTemplateOrigin((({source,...origin})=>origin)(review))).toBe(true);
 validateTemplateInput(review.inputSchema,{target:"src/"});
 validateTemplateInput(review.inputSchema,{target:"src/",base:"main",focus:["并发"],context:"",language:"中文"});
 expect(()=>validateTemplateInput(review.inputSchema,{})).toThrow("参数无效");
 expect(()=>validateTemplateInput(review.inputSchema,{target:"",base:"main"})).toThrow("参数无效");
 expect(()=>validateTemplateInput(review.inputSchema,{target:"src/",focus:[]})).toThrow("参数无效");
 expect(()=>validateTemplateInput(review.inputSchema,{target:"src/",depth:"deep"})).toThrow("参数无效");
});
test("已保存且目录不再提供的版本仍按冻结源码/Schema编辑，旧批准保持不变",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-template-upgrade-"));roots.push(root);
 const state=join(root,"state"),service=new LeadService(state,async()=>{throw Error("must not initialize");});
 const current=listWorkflowTemplates()[0]!;
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"目录升级",template:{id:current.id,version:current.version,sourceHash:current.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2}}});
 const first=task.workflowRevisions[0]!;
 const old=defineTemplate(current.id,99,`import { phase } from "wave-flow";\nexport const meta={name:"${current.id}",description:"冻结旧版",phases:[{title:"旧版"}],inputSchema:{type:"object",properties:{legacy:{type:"integer"}},required:["legacy"],additionalProperties:false}};\nexport default async function run(args){phase("旧版");return args;}`,"旧版本Schema");
 const {source,...templateOrigin}=old;
 const opened=await LeadJournal.open(task.leadRunId,state);
 const at=new Date().toISOString();
 await opened.journal.append({type:"workflow.revision_proposed",leadRunId:task.leadRunId,at,revision:{...first,revision:2,parentRevision:1,source,sourceHash:old.sourceHash,sourceFormat:"module",preview:undefined,templateOrigin,input:{legacy:3},saveRequestId:crypto.randomUUID(),savePayloadHash:"a".repeat(64),createdAt:at}});
 const reopened=new LeadService(state,async()=>{throw Error("must not initialize");});
 await reopened.acceptWorkflowRevision(task.leadRunId,2);
 const next=await reopened.saveTemplate(task.leadRunId,crypto.randomUUID(),{id:old.id,version:old.version,sourceHash:old.sourceHash,input:{legacy:4}},first.cardId);
 expect(next.workflowRevisions[2]!.source).toBe(source);
 expect(next.workflowRevisions[2]!.input).toEqual({legacy:4});
 expect(next.workflowRevisions[1]!.acceptedAt).not.toBeNull();
 expect(next.workflowRevisions[1]!.input).toEqual({legacy:3});
 await expect(reopened.saveTemplate(task.leadRunId,crypto.randomUUID(),{id:old.id,version:old.version,sourceHash:old.sourceHash,input:{target:"src/"}},first.cardId)).rejects.toThrow("参数无效");
});
test("预置创建、保存重开只一Task/候选，无模型/执行；参数修改同卡追加版本",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-templates-"));roots.push(root);
 const state=join(root,"state");let sessions=0;
 const service=new LeadService(state,async()=>{sessions++;throw Error("must not initialize");});
 const template=listWorkflowTemplates()[0]!;
 const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2,context:""}};
 const request={clientRequestId:crypto.randomUUID(),projectId:"project",text:template.meta.description,template:selection};
 const [a,b]=await Promise.all([service.startTask(root,request),service.startTask(root,request)]);
 expect(a.leadRunId).toBe(b.leadRunId);expect(a.workflowRevisions).toHaveLength(1);expect(a.executions).toHaveLength(0);expect(sessions).toBe(0);expect(a.workflowRevisions[0]!.acceptedAt).toBeNull();
 const reopened=new LeadService(state,async()=>{throw Error("must not initialize");});
 expect((await reopened.startTask(root,request)).workflowRevisions).toHaveLength(1);
 const cardId=a.workflowRevisions[0]!.cardId!;
 await reopened.acceptWorkflowRevision(a.leadRunId,1);
 const next=await reopened.saveTemplate(a.leadRunId,crypto.randomUUID(),{...selection,input:{...selection.input,target:"test/"}},cardId);
 expect(next.workflowRevisions[1]!.cardId).toBe(cardId);expect(next.workflowRevisions[1]!.acceptedAt).toBeNull();expect(next.workflowRevisions[0]!.acceptedAt).not.toBeNull();
 expect((await LeadJournal.open(a.leadRunId,state)).snapshot.workflowRevisions[1]!.input!.target).toBe("test/");
 await expect(reopened.saveTemplate(a.leadRunId,crypto.randomUUID(),selection)).rejects.toThrow("已有候选");
 await expect(reopened.saveTemplate(a.leadRunId,crypto.randomUUID(),{...selection,input:{target:""}})).rejects.toThrow("参数无效");
 expect((await reopened.snapshot(a.leadRunId)).workflowRevisions).toHaveLength(2);
});
test("主控修改模板同卡追加generated版本并耐久保留derivedFrom",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-template-derived-"));roots.push(root);
 const source=`import { phase } from "wave-flow";\nexport const meta={name:"derived-review",description:"独立方案",phases:[{title:"复核"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};\nexport default async function run(args){phase("复核");return {};}`;
 const service=new LeadService(join(root,"state"),async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{await actions.proposeWorkflowRevision(source,"修改目标","只读复核");return "已修改";}}));
 const template=listWorkflowTemplates()[0]!;
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"预置审查",template:{id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2}}});
 await service.send(task.leadRunId,"请修改控制流");
 for(let n=0;n<100;n++){if((await service.snapshot(task.leadRunId)).status==="idle")break;await Bun.sleep(5);}
 const snapshot=(await LeadJournal.open(task.leadRunId,join(root,"state"))).snapshot;
 expect(snapshot.workflowRevisions).toHaveLength(2);
 expect(snapshot.workflowRevisions[1]!.cardId).toBe(snapshot.workflowRevisions[0]!.cardId);
 expect(snapshot.workflowRevisions[1]!.templateOrigin).toBeUndefined();
 expect(snapshot.workflowRevisions[1]!.derivedFrom?.sourceHash).toBe(template.sourceHash);
 expect(snapshot.workflowRevisions[1]!.acceptedAt).toBeNull();
});
test("主控等待期间保存模板被拒绝，Journal与候选零变化",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-template-busy-"));roots.push(root);
 let finish!:()=>void;
 const waiting=new Promise<void>(resolve=>{finish=resolve;});
 const service=new LeadService(join(root,"state"),async()=>({isRunning:true,subscribe:()=>()=>{},abort:()=>finish(),prompt:async()=>{await waiting;return "结束";}}));
 const template=listWorkflowTemplates()[0]!;
 const selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2}};
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"忙碌测试",template:selection});
 await service.send(task.leadRunId,"等待用户讨论");
 const before=await LeadJournal.open(task.leadRunId,join(root,"state"));
 try{
   await expect(service.saveTemplate(task.leadRunId,crypto.randomUUID(),selection,task.workflowRevisions[0]!.cardId)).rejects.toThrow("空闲");
   const after=await LeadJournal.open(task.leadRunId,join(root,"state"));
   expect(after.events).toHaveLength(before.events.length);expect(after.snapshot.executions).toHaveLength(0);expect(after.snapshot.workflowRevisions).toHaveLength(1);
 }finally{finish();for(let n=0;n<100;n++){if((await service.snapshot(task.leadRunId)).status==="idle")break;await Bun.sleep(5);}service.close();}
});
test("主控参数模式复用模板源码、同卡追加，过期baseRevision拒绝且不执行",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wf-template-parameters-"));roots.push(root);
 let oldRejected=false;
 const service=new LeadService(join(root,"state"),async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{
   await actions.proposeWorkflowRevision("","审查","只读",{baseRevision:1,input:{target:"test/",focus:["安全"],maxFindings:4}});
   try{await actions.proposeWorkflowRevision("","审查","只读",{baseRevision:1,input:{target:"old/",focus:["安全"],maxFindings:2}});}catch{oldRejected=true;}
   return "参数已整理";
 }}));
 const template=listWorkflowTemplates()[0]!;
 const task=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"参数整理",template:{id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["安全"],maxFindings:2}}});
 await service.send(task.leadRunId,"改为test/，最多4个问题");
 for(let n=0;n<100;n++){if((await service.snapshot(task.leadRunId)).status==="idle")break;await Bun.sleep(5);}
 const snapshot=(await LeadJournal.open(task.leadRunId,join(root,"state"))).snapshot;
 expect(oldRejected).toBe(true);expect(snapshot.workflowRevisions).toHaveLength(2);
 expect(snapshot.workflowRevisions[1]!.source).toBe(template.source);
 expect(snapshot.workflowRevisions[1]!.cardId).toBe(snapshot.workflowRevisions[0]!.cardId);
 expect(snapshot.workflowRevisions[1]!.input?.target).toBe("test/");
 expect(snapshot.workflowRevisions[1]!.acceptedAt).toBeNull();expect(snapshot.executions).toHaveLength(0);
});
