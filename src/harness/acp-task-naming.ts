import { rm } from "node:fs/promises";
import { AcpSessionClient, type AcpLauncher, type AcpTransportFactory, type AcpTransport } from "../adapters/acp-session";
import { prepareIsolatedLauncher, type SessionIsolationProfile } from "../runtimes/session-isolation";
import { managedAcpTransport } from "../workspace/managed-acp-transport";
import { WriterProcessGroups } from "../workspace/writer-process-group";
import { prepareSessionScratch } from "../workspace/session-scratch";
import { taskNamingPrompt, type TaskNamingContext } from "./task-naming";

/** 独立一次性ACP命名，无MCP/主控历史；只返回正常结束的文本，临时状态在退出核验后删除。 */
export async function generateAcpTaskTitle(options: {
  /** Registry复核后的主控CLI启动配置。 */ readonly launcher: AcpLauncher;
  /** 已验证的私有状态准备能力；缺失拒绝。 */ readonly isolation?: SessionIsolationProfile;
  /** Engine私有临时根，不在业务项目内。 */ readonly scratchRoot: string;
  /** 仅用于核验临时根不与项目重叠，session实际cwd使用scratch。 */ readonly projectCwd: string;
  /** 创建时冻结的命名材料。 */ readonly context: TaskNamingContext;
  /** 覆盖启动/回合的取消与超时信号。 */ readonly signal: AbortSignal;
  /** 独立协议测试传输；生产缺省。 */ readonly transport?: AcpTransportFactory;
}): Promise<string> {
  const scratch = await prepareSessionScratch(options.scratchRoot, options.projectCwd);
  let client: AcpSessionClient | undefined, owned: AcpTransport | undefined;
  const abort = new AbortController(), signal = AbortSignal.any([options.signal,abort.signal]);
  let text = "";
  const closeOnAbort = () => client?.close();
  try {
    const launcher = await prepareIsolatedLauncher(options.isolation,options.launcher,scratch,"harness");
    if (signal.aborted) throw new Error("命名已取消。");
    const transport = managedAcpTransport({boundary:{workspace:null,scratch,controlFiles:[],readOnlyPaths:options.isolation?.readOnlyPaths(launcher)??[],cliWritableRoots:options.isolation?.writableRoots?.(launcher)??[],protectedDirectories:[]},groups:new WriterProcessGroups(),bindWriter:async()=>{},transport:options.transport});
    client = new AcpSessionClient(launcher,async(...args)=>{const created=await transport(...args);owned=created;if(signal.aborted){created.close();throw new Error("命名启动已取消。");}return created;},()=>{abort.abort();return {outcome:{outcome:"cancelled"}};});
    signal.addEventListener("abort",closeOnAbort,{once:true});
    client.subscribe(({update})=>{
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {abort.abort();client?.close();return;}
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        text += update.content.text;
        if (text.length > 2048) {abort.abort();client?.close();}
      }
    });
    await client.initialize(signal);
    await client.createSession(scratch,signal,[]);
    const turn = await client.prompt(taskNamingPrompt(options.context),signal);
    if(signal.aborted || turn.stopReason !== "end_turn") throw new Error("命名未正常结束。");
    return text;
  } finally {
    signal.removeEventListener("abort",closeOnAbort);
    client?.close();
    if(owned) {owned.close();await owned.verifyClosed!();}
    await rm(scratch,{recursive:true,force:true});
  }
}
