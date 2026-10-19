import {afterEach,expect,test} from "bun:test";
import {mkdtemp,mkdir,realpath,rm,readdir,copyFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import {generateAcpTaskTitle} from "../../src/harness/acp-task-naming";
import {parseTaskNamingResult} from "../../src/harness/task-naming";
import {CliRuntimeRegistry} from "../../src/runtimes/registry";
import {adapterById} from "../../src/runtimes/adapter-catalog";
import {resolveHarnessLauncher} from "../../src/runtimes/worker-launcher-resolver";
import {HarnessService} from "../../src/harness/service";
import {DeterministicHarnessSession} from "../../src/harness/deterministic-session";
import {HarnessJournal} from "../../src/harness/journal";
import {waveFlowHome} from "../../src/journal/paths";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test.skipIf(process.platform!=="darwin")("独立ACP只收最终JSON，无MCP、拒绝工具/权限、取消回收临时目录",async()=>{
  for(const mode of ["success","tool","permission","cancel","init-fail"]){
    const root=await realpath(await mkdtemp(join(tmpdir(),"wf-name-acp-")));roots.push(root);const project=join(root,"project");await mkdir(project);
    let exit!:(code:number)=>void,closed=0,newArgs:acp.NewSessionRequest|undefined;
    const exited=new Promise<number>(resolve=>exit=resolve);
    const stop=()=>{closed++;exit(0);};
    const pending=generateAcpTaskTitle({launcher:{id:"test",command:"/bin/true",args:[]},isolation:{enabledRoles:["harness"],prepare:async l=>l,readOnlyPaths:()=>[]},projectCwd:project,scratchRoot:join(root,"scratch"),context:{source:"auto",userIntent:"小说接力"},signal:AbortSignal.timeout(mode==="cancel"?60:2000),transport:async()=>{
      const a=new TransformStream<Uint8Array,Uint8Array>(),b=new TransformStream<Uint8Array,Uint8Array>();
      const agent=acp.agent({name:"naming-test"}).onRequest(acp.methods.agent.initialize,()=>{if(mode==="init-fail")throw Error("initialize失败");return {protocolVersion:acp.PROTOCOL_VERSION,agentCapabilities:{}};})
      .onRequest(acp.methods.agent.session.new,c=>{newArgs=c.params;return {sessionId:"private-name"};})
      .onRequest(acp.methods.agent.session.prompt,async c=>{
        if(mode==="cancel")return new Promise<acp.PromptResponse>(()=>{});
        if(mode==="tool")await c.client.notify(acp.methods.client.session.update,{sessionId:c.params.sessionId,update:{sessionUpdate:"tool_call",toolCallId:"tool",title:"读取",kind:"read",status:"pending"}});
        if(mode==="permission")await c.client.request(acp.methods.client.session.requestPermission,{sessionId:c.params.sessionId,toolCall:{toolCallId:"permission",title:"批准"},options:[{optionId:"allow",name:"允许",kind:"allow_once"}]});
        await c.client.notify(acp.methods.client.session.update,{sessionId:c.params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:'{"title":"小说接力"}'}}});return {stopReason:"end_turn"};
      });const connection=agent.connect(acp.ndJsonStream(b.writable,a.readable));
      return {stream:acp.ndJsonStream(a.writable,b.readable),exited,close(){connection.close();stop();},writerProcess:{pid:2147483000,exited,terminate:stop}};
    }});
    if(mode==="success")expect(parseTaskNamingResult(await pending)).toBe("小说接力");else await expect(pending).rejects.toThrow();
    expect(closed).toBeGreaterThan(0);expect(await readdir(join(root,"scratch"))).toEqual([]);
    if(newArgs){expect(newArgs.mcpServers).toEqual([]);expect(newArgs.cwd).not.toBe(project);}
  }
});
test.skipIf(process.env.WF_REAL_NAMING_ACCEPTANCE!=="1")("真实所选主控CLI后台命名只交付标题并清理session目录",async()=>{
  const runtime=process.env.WF_REAL_NAMING_CLI === "kimi" ? await new CliRuntimeRegistry().resolveWorker("kimi") : await new CliRuntimeRegistry().resolveSelectedHarness();
  const root=await realpath(await mkdtemp(join(tmpdir(),"wf-real-naming-")));roots.push(root);const project=join(root,"project");await mkdir(project);
  const service=new HarnessService(join(root,"state"),async()=>new DeterministicHarnessSession());
  let namingError:Error|undefined;
  service.setNamingGenerator(async(context,_snapshot,signal)=>{
    try{return await generateAcpTaskTitle({launcher:resolveHarnessLauncher(runtime),isolation:adapterById(runtime.verifiedAdapter.adapterId)?.sessionIsolation,projectCwd:project,scratchRoot:join(root,"scratch"),context,signal});}
    catch(error){namingError=error instanceof Error?error:Error(String(error));console.log(JSON.stringify({cli:runtime.cli,namingError:namingError.message}));throw error;}
  });
  const task=await service.startTask(project,{projectId:"p",clientRequestId:crypto.randomUUID(),text:"帮我在当前仓库新建novel文件夹，并派三个agent接力写小说，每人200字。"});
  const deadline=Date.now()+60000;let saved=await HarnessJournal.open(task.harnessRunId,join(root,"state"));
  while(!namingError&&!saved.events.some(e=>e.type==="harness.title_generated")&&Date.now()<deadline){await Bun.sleep(100);saved=await HarnessJournal.open(task.harnessRunId,join(root,"state"));}
  if(namingError){service.close();throw namingError;}
  service.close();const title=saved.snapshot.task!.title;
  expect(saved.events.filter(e=>e.type==="harness.title_generated")).toHaveLength(1);expect(title).not.toBe(task.task!.title);expect(await readdir(join(root,"scratch"))).toEqual([]);expect(await readdir(project)).toEqual([]);
  console.log(JSON.stringify({cli:runtime.cli,title,sessionScratchRemoved:true,projectUnchanged:true}));
},70000);
test.skipIf(process.env.WF_PACKAGED_NAMING_ACCEPTANCE!=="1")("打包Engine真实本地Task后台命名，事件与Journal一致且无Workflow执行",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"wf-packaged-name-")));roots.push(root);
  const project=join(root,"project"),state=join(root,"state");await mkdir(project);await mkdir(state,{mode:0o700});
  await copyFile(join(waveFlowHome(),"runtimes.json"),join(state,"runtimes.json"));
  const file=join(project,"workflow.ts");await writeFile(file,'export const meta={name:"novel-relay",description:"三个Agent每人写200字接力创作小说",phases:[{title:"写作"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){return {}; }');
  const binary=join(import.meta.dir,"../../src-tauri/target/release/bundle/macos/Wave Flow.app/Contents/MacOS/wave-flow-desktop-engine");
  const child=Bun.spawn([binary],{stdin:"pipe",stdout:"pipe",stderr:"pipe",env:{...process.env,WAVE_FLOW_HOME:state}});
  const waiting=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let ready!:(v?:unknown)=>void;
  const readyPromise=new Promise(r=>ready=r),frames:any[]=[];
  const reader=(async()=>{let buffer="";for await(const bytes of child.stdout){buffer+=new TextDecoder().decode(bytes);let end;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const value=JSON.parse(line);if(value.type==="ready")ready();else if(value.requestId){const waiter=waiting.get(value.requestId);waiting.delete(value.requestId);value.ok?waiter?.resolve(value.result):waiter?.reject(Error(value.error));}else frames.push(value);}}})();
  const stderr=new Response(child.stderr).text();
  async function request(action:string,args:Record<string,unknown>={},method="engine.action"):Promise<any>{const requestId=crypto.randomUUID();const pending=new Promise((resolve,reject)=>waiting.set(requestId,{resolve,reject}));child.stdin.write(JSON.stringify({requestId,method,action,args})+"\n");return pending;}
  try{
    await Promise.race([readyPromise,Bun.sleep(10000).then(()=>{throw Error("打包Engine启动超时");})]);
    const registered=await request("projects.create",{cwd:project}),projectId=registered.project.projectId;
    const checked=await request("workflows.preflightLocal",{projectId,path:file});
    const created=await request("workflows.createLocalTask",{projectId,path:file,sourceHash:checked.sourceHash,input:{},clientRequestId:crypto.randomUUID()});
    const id=created.harness.harnessRunId,deadline=Date.now()+60000;let snapshot=created.harness;
    while(!frames.some(f=>f.stream==="harness"&&f.event?.type==="title_changed")&&Date.now()<deadline){await Bun.sleep(100);snapshot=(await request("harnesses.get",{harnessRunId:id})).harness;}
    snapshot=(await request("harnesses.get",{harnessRunId:id})).harness;
    const saved=await HarnessJournal.open(id,join(state,"harness-runs"));
    expect(snapshot.task.title).not.toBe("三个Agent每人写200字接力创作小说");expect(snapshot.task.title).toBe(saved.snapshot.task?.title);expect(snapshot.executions).toHaveLength(0);expect(snapshot.messages).toHaveLength(1);expect(frames.some(f=>f.stream==="harness"&&f.event?.type==="title_changed")).toBe(true);expect(await readdir(join(state,"naming-scratch"))).toEqual([]);expect(await readdir(project)).toEqual(["workflow.ts"]);
    console.log(JSON.stringify({packagedEngine:true,title:snapshot.task.title,source:"local",executions:0,temporarySessionRemoved:true}));
    await request("",{},"engine.shutdown");expect(await child.exited).toBe(0);await reader;
  }finally{child.kill();await stderr;}
},80000);
