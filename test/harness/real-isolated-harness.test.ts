import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { adapterById } from "../../src/runtimes/adapter-catalog";
import { resolveHarnessLauncher } from "../../src/runtimes/worker-launcher-resolver";
import { createIsolatedHarness } from "../../src/harness/isolated-harness";
import { prepareSessionScratch } from "../../src/workspace/session-scratch";
import { HarnessService } from "../../src/harness/service";
import { HarnessControlPipe } from "../../src/harness/harness-control-pipe";
import { buildHarnessSystemPrompt } from "../../src/harness/harness-prompt";
import { prepareIsolatedLauncher } from "../../src/runtimes/session-isolation";
import { managedAcpTransport } from "../../src/workspace/managed-acp-transport";
import { WriterProcessGroups } from "../../src/workspace/writer-process-group";
import { AcpSessionClient, bunAcpTransport } from "../../src/adapters/acp-session";
import type * as acp from "@agentclientprotocol/sdk";

// 显式验收不发送模型prompt；仅证明真实CLI在私有Home及OS边界下可启动空工具MCP，不证明四工具业务调用。
test.skipIf(process.env.WF_REAL_HARNESS_ISOLATION_ACCEPTANCE!=="1")("真实主控隔离完成initialize与私有MCP session-new",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-real-harness-isolation-"))),cwd=join(root,"project"),state=join(root,"state");await mkdir(cwd);await mkdir(state,{mode:0o700});
  const registry=new CliRuntimeRegistry();const cli=process.env.WF_REAL_HARNESS_CLI==="kimi"?"kimi":"codex";const runtime=await registry.resolveWorker(cli),entry=adapterById(runtime.verifiedAdapter.adapterId)!;
  const scratch=await prepareSessionScratch(state,cwd),launcher=await prepareIsolatedLauncher(entry.sessionIsolation,resolveHarnessLauncher(runtime),scratch,"harness"),groups=new WriterProcessGroups();
  const transport=managedAcpTransport({boundary:{workspace:null,scratch,controlFiles:[],readOnlyPaths:entry.sessionIsolation!.readOnlyPaths(launcher),cliWritableRoots:entry.sessionIsolation!.writableRoots?.(launcher)??[],protectedDirectories:[cwd]},groups,bindWriter:async()=>{}});
  const client=new AcpSessionClient(launcher,transport,"deny");const signal=AbortSignal.timeout(20_000);
  const mcp:{name:string;command:string;args:string[];env:[]}={name:"wave-flow-harness",command:process.execPath,args:[join(import.meta.dir,"../../src/desktop/engine-main.ts"),"__mcp-probe"],env:[]};
  try{const initialized=await client.initialize(signal);const binding=await client.createSession(cwd,signal,[mcp as acp.McpServer],10_000);expect(initialized.agentInfo?.name).toBeTruthy();expect(binding.sessionId).toBeTruthy();console.log(JSON.stringify({root,cli,adapter:entry.adapterId,sessionId:binding.sessionId}));}
  finally{client.close();await client.verifyClosed();}
},30_000);

test.skipIf(process.env.WF_REAL_HARNESS_MODEL_ACCEPTANCE!=="1")("真实隔离主控原生跨目录读与窄工具调用，不创建执行或修改项目",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-real-harness-model-"))),cwd=join(root,"project");await mkdir(cwd);
  const inside=join(cwd,"marker.txt"),outside=join(root,"outside.txt");await writeFile(inside,"INSIDE_FIXTURE_42\n");await writeFile(outside,"OUTSIDE_FIXTURE_73\n");
  const registry=new CliRuntimeRegistry(),cli=process.env.WF_REAL_HARNESS_CLI==="kimi"?"kimi":"codex",runtime=await registry.resolveWorker(cli),entry=adapterById(runtime.verifiedAdapter.adapterId)!;
  const pipes:HarnessControlPipe[]=[];
  const service=new HarnessService(join(root,"harness-runs"),async(id,project,prior)=>{
    const scratch=await prepareSessionScratch(join(root,"scratch"),project),pipe=new HarnessControlPipe(request=>service.mcpTools(id,request),scratch);pipes.push(pipe);
    const mcp={name:"wave-flow-harness",command:process.execPath,args:[join(import.meta.dir,"../../src/desktop/engine-main.ts"),"__harness-mcp"],env:[{name:"WF_HARNESS_MCP_REQUEST_FIFO",value:pipe.endpoints.requestFifo},{name:"WF_HARNESS_MCP_RESPONSE_FIFO",value:pipe.endpoints.responseFifo}]} as acp.McpServer;
    const observe: import("../../src/adapters/acp-session").AcpTransportFactory | undefined = process.env.WF_REAL_HARNESS_TRACE === "1" ? async(launcher,signal)=>{
      const value=await bunAcpTransport(launcher,signal);
      const readable=value.stream.readable.pipeThrough(new TransformStream({transform(message,controller){
        // 只打印协议种类/会话身份，不打印正文、prompt、工具参数或凭据。
        const raw=message as unknown as {method?:string;params?:{sessionId?:string;update?:{sessionUpdate?:string}};id?:unknown;result?:{stopReason?:string};error?:{code?:number;message?:string}};
        console.log(JSON.stringify({method:raw.method,sessionId:raw.params?.sessionId,update:raw.params?.update?.sessionUpdate,responseId:raw.id,stopReason:raw.result?.stopReason,errorCode:raw.error?.code}));
        controller.enqueue(message);
      }}));
      return {...value,stream:{...value.stream,readable}};
    } : undefined;
    return createIsolatedHarness({launcher:resolveHarnessLauncher(runtime),isolation:entry.sessionIsolation,cwd:project,scratch,prompt:buildHarnessSystemPrompt(),prior,mcp,transport:observe});
  });
  try{
    const created=await service.create(cwd);
    console.log(JSON.stringify({root,cli,task:created.harnessRunId}));
    await service.send(created.harnessRunId,`只做读取验收，不设计或执行Workflow。用当前CLI原生文件工具读取${inside}与${outside}，然后调用wave-flow-harness的inspect_execution读取执行列表。最后报告两个标记及执行数量；不得修改文件、安装依赖、创建Worker或提交草案。`);
    const deadline=Date.now()+100_000;
    let snapshot=await service.snapshot(created.harnessRunId);
    while(snapshot.status==="running"&&Date.now()<deadline){await Bun.sleep(100);snapshot=await service.snapshot(created.harnessRunId);}
    console.log(JSON.stringify({task:created.harnessRunId,status:snapshot.status,diagnostic:snapshot.diagnostic}));
    expect(snapshot.status).toBe("idle");const answer=snapshot.messages.at(-1)?.text??"";
    expect(answer).toContain("INSIDE_FIXTURE_42");expect(answer).toContain("OUTSIDE_FIXTURE_73");expect(snapshot.executions).toHaveLength(0);expect(snapshot.workflowRevisions).toHaveLength(0);
    expect(snapshot.conversationEntries.some(item=>item.kind==="tool"&&item.source==="engine-mcp"&&item.name==="读取执行状态"&&item.status==="completed")).toBe(true);
    expect(await Bun.file(inside).text()).toBe("INSIDE_FIXTURE_42\n");expect(await Bun.file(outside).text()).toBe("OUTSIDE_FIXTURE_73\n");
  }finally{await service.close();pipes.forEach(pipe=>pipe.close());}
},120_000);

// 测试仅对临时夹具提出写请求，以真实结构化工具失败和文件字节核验证明拒绝路径。
// 不从自然语言“失败”推断业务状态，也不对实际CLI开放未验证的反向写接口。
test.skipIf(process.env.WF_REAL_FILE_DENIAL_ACCEPTANCE !== "1")("真实CLI工作区外写固定拒绝，不存在批准后扩权", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-file-denial-"))), cwd = join(root, "project");
  await mkdir(cwd); const target = join(root, "outside.txt"); await writeFile(target, "ORIGINAL_FIXTURE\n");
  const runtime = await new CliRuntimeRegistry().resolveWorker("codex"), entry = adapterById(runtime.verifiedAdapter.adapterId)!;
  const scratch = await prepareSessionScratch(join(root, "scratch"), cwd);
  const launcher = await prepareIsolatedLauncher(entry.sessionIsolation, resolveHarnessLauncher(runtime), scratch, "harness");
  const transport = managedAcpTransport({ boundary: { workspace: null, scratch, controlFiles: [], protectedDirectories: [cwd], readOnlyPaths: entry.sessionIsolation!.readOnlyPaths(launcher), cliWritableRoots: entry.sessionIsolation!.writableRoots?.(launcher) ?? [] }, groups: new WriterProcessGroups(), bindWriter: async () => {} });
  const client = new AcpSessionClient(launcher, transport, "allow");
  const failedTools = new Set<string>();
  client.subscribe(({ update }) => {
    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.status === "failed") failedTools.add(update.toolCallId);
  });
  try {
    const signal = AbortSignal.timeout(90_000);
    await client.initialize(signal); const binding = await client.createSession(cwd, signal);
    const turn = await client.prompt(`这是OS拒绝路径验收，目标只是一份测试夹具。请使用一次原生Shell执行 printf CHANGED_FIXTURE > ${target}。该操作预期被外层OS拒绝，失败后停止，不提权、不换工具重试、不修改其他文件、不联网。只报告此次结果。`, signal);
    expect(turn.stopReason).toBe("end_turn");
    expect(failedTools.size).toBeGreaterThan(0);
    expect(await Bun.file(target).text()).toBe("ORIGINAL_FIXTURE\n");
    console.log(JSON.stringify({ root, sessionId: binding.sessionId, failedToolCount: failedTools.size }));
  } finally { client.close(); await client.verifyClosed(); }
}, 100_000);
