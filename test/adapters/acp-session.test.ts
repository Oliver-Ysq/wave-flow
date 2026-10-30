import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAmbiguousPromptError, AcpSessionClient, type AcpTransportFactory } from "../../src/adapters/acp-session";

function fakeTransport(events: acp.SessionUpdate[], hooks: { cancelled: number; loaded: string[]; newSessionMeta?: Record<string, unknown> }): AcpTransportFactory {
  return async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "fake-acp" })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
      .onRequest(acp.methods.agent.session.new, (context) => { hooks.newSessionMeta = context.params._meta as Record<string, unknown> | undefined; return { sessionId: "acp-session" }; })
      .onRequest(acp.methods.agent.session.load, (context) => { hooks.loaded.push(context.params.sessionId); return {}; })
      .onRequest(acp.methods.agent.session.prompt, async (context) => {
        await context.client.notify(acp.methods.client.session.update, { sessionId: context.params.sessionId, update: events[0]! });
        return { stopReason: "end_turn" };
      })
      .onNotification(acp.methods.agent.session.cancel, () => { hooks.cancelled += 1; });
    const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
      stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
      exited: new Promise<number>(() => {}),
      close: () => connection.close(),
    };
  };
}

test("ACP session client records a binding, forwards stream events, cancels and loads", async () => {
  const hooks = { cancelled: 0, loaded: [] as string[] };
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, fakeTransport([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
  ], hooks));
  const init = await client.initialize(new AbortController().signal);
  expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
  expect((await client.createSession("/workspace", new AbortController().signal)).sessionId).toBe("acp-session");
  const received: acp.SessionUpdate[] = [];
  client.subscribe((event) => received.push(event.update));
  expect((await client.prompt("hi", new AbortController().signal)).stopReason).toBe("end_turn");
  expect(received).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }]);
  await client.cancel(new AbortController().signal);
  expect(hooks.cancelled).toBe(1);
  await client.loadSession("saved-session", "/workspace", new AbortController().signal);
  expect(hooks.loaded).toEqual(["saved-session"]);
  client.close();
});

/**
 * 压缩契约必须由客户端显式广告：未声明 session.compaction 时，Codex 与 Claude Code 适配器
 * 都会把压缩降级成一条 tool_call 呈现，结构化压缩事实不可得。
 */
test("initialize 只在显式要求时广告压缩能力", async () => {
  const advertised: unknown[] = [];
  const factory: AcpTransportFactory = async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "capture-acp" })
      .onRequest(acp.methods.agent.initialize, (context) => { advertised.push(context.params.clientCapabilities); return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }; })
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "s" }));
    const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return { stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), exited: new Promise<number>(() => {}), close: () => connection.close() };
  };
  // 默认不广告：没有压缩消费者的会话不得广告，否则等于承诺了却不履行压缩契约。
  const plain = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, factory);
  await plain.initialize(new AbortController().signal);
  expect(advertised[0]).not.toHaveProperty("session");
  plain.close();
  const worker = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, factory, "allow", { compaction: true });
  await worker.initialize(new AbortController().signal);
  expect(advertised[1]).toMatchObject({ session: { compaction: {} } });
  worker.close();
});

test("携带私有 MCP 的 session/new 会等待 MCP startup 后才返回", async () => {
  const hooks: { cancelled: number; loaded: string[]; newSessionMeta?: Record<string, unknown> } = { cancelled: 0, loaded: [] };
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, fakeTransport([], hooks));
  await client.initialize(new AbortController().signal);
  await client.createSession("/workspace", new AbortController().signal, [{ name: "private", command: "/mcp", args: [], env: [] }], 10_000);
  expect(hooks.newSessionMeta).toEqual({ mcpStartupAwaitTimeoutMs: 10_000 });
  client.close();
});

test("ACP prompt becomes ambiguous if its transport closes before a response", async () => {
  const factory: AcpTransportFactory = async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "ambiguous-acp" })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "acp-session" }))
      .onRequest(acp.methods.agent.session.prompt, () => new Promise<never>(() => {}));
    const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
      stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
      exited: new Promise<number>(() => {}),
      close: () => connection.close(),
    };
  };
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, factory);
  await client.initialize(new AbortController().signal);
  await client.createSession("/workspace", new AbortController().signal);
  const pending = client.prompt("may have arrived", new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  client.close();
  await expect(pending).rejects.toBeInstanceOf(AcpAmbiguousPromptError);
});

for (const scenario of ["once", "always", "none", "deny"] as const) test(`ACP权限选择 ${scenario} 不扩大CLI提供的选项`, async () => {
  const mode = scenario === "deny" ? "deny" : "allow";
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let permission: acp.RequestPermissionResponse | null = null;
  const app = acp.agent({ name: "permission-acp" })
    .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "acp-session" }))
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      permission = await context.client.request(acp.methods.client.session.requestPermission, {
        sessionId: context.params.sessionId,
        toolCall: { toolCallId: "tool", kind: "execute", status: "pending", title: "Run command" },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          ...(scenario === "once" || scenario === "deny" ? [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }] : []),
          ...(scenario !== "none" ? [{ optionId: "always", name: "Always", kind: "allow_always" as const }] : []),
        ],
      });
      return { stopReason: "end_turn" };
    });
  const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, async () => ({ stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), exited: new Promise<number>(() => {}), close: () => connection.close() }), mode);
  await client.initialize(new AbortController().signal);
  await client.createSession("/workspace", new AbortController().signal);
  await client.prompt("run", new AbortController().signal);
  expect(permission).toMatchObject(scenario === "once" ? { outcome: { outcome: "selected", optionId: "allow" } } : scenario === "always" ? { outcome: { outcome: "selected", optionId: "always" } } : { outcome: { outcome: "cancelled" } });
  client.close();
});

test("ACP权限可交给异步宿主Resolver，原请求和精确选项不丢失", async()=>{
  const clientToAgent=new TransformStream<Uint8Array,Uint8Array>(),agentToClient=new TransformStream<Uint8Array,Uint8Array>();let received:acp.RequestPermissionRequest|null=null,permission:acp.RequestPermissionResponse|null=null;
  const app=acp.agent({name:"resolver-acp"}).onRequest(acp.methods.agent.initialize,()=>({protocolVersion:acp.PROTOCOL_VERSION,agentCapabilities:{}})).onRequest(acp.methods.agent.session.new,()=>({sessionId:"s"})).onRequest(acp.methods.agent.session.prompt,async context=>{permission=await context.client.request(acp.methods.client.session.requestPermission,{sessionId:"s",toolCall:{toolCallId:"t",kind:"edit",status:"pending",title:"Edit outside",locations:[{path:"/outside/file"}],rawInput:{path:"/outside/file"}},options:[{optionId:"no",name:"Reject",kind:"reject_once"},{optionId:"yes",name:"Allow once",kind:"allow_once"}]});return{stopReason:"end_turn"};});
  const connection=app.connect(acp.ndJsonStream(agentToClient.writable,clientToAgent.readable));
  const client=new AcpSessionClient({id:"future-acp",command:"fake",args:[]},async()=>({stream:acp.ndJsonStream(clientToAgent.writable,agentToClient.readable),exited:new Promise<number>(()=>{}),close:()=>connection.close()}),async request=>{received=request;await Bun.sleep(1);return{outcome:{outcome:"selected",optionId:"no"}};});
  await client.initialize(new AbortController().signal);await client.createSession("/workspace",new AbortController().signal);await client.prompt("test",new AbortController().signal);
  expect(received).toMatchObject({sessionId:"s",toolCall:{toolCallId:"t",kind:"edit",locations:[{path:"/outside/file"}],rawInput:{path:"/outside/file"}}});expect(permission as acp.RequestPermissionResponse|null).toEqual({outcome:{outcome:"selected",optionId:"no"}});client.close();
});

test("取消回合时未响应的权限等待立即cancelled，迟到allow不能复活", async()=>{
  const clientToAgent=new TransformStream<Uint8Array,Uint8Array>(),agentToClient=new TransformStream<Uint8Array,Uint8Array>();let permission:acp.RequestPermissionResponse|null=null,resolveDecision!:(value:acp.RequestPermissionResponse)=>void,entered!:(value?:void)=>void;
  const waiting=new Promise<void>(resolve=>entered=resolve),decision=new Promise<acp.RequestPermissionResponse>(resolve=>resolveDecision=resolve);
  const app=acp.agent({name:"cancel-permission"}).onRequest(acp.methods.agent.initialize,()=>({protocolVersion:acp.PROTOCOL_VERSION,agentCapabilities:{}})).onRequest(acp.methods.agent.session.new,()=>({sessionId:"s"})).onRequest(acp.methods.agent.session.prompt,async context=>{permission=await context.client.request(acp.methods.client.session.requestPermission,{sessionId:"s",toolCall:{toolCallId:"t",kind:"edit",status:"pending",title:"Edit"},options:[{optionId:"yes",name:"Allow",kind:"allow_once"}]});return{stopReason:"end_turn"};}).onNotification(acp.methods.agent.session.cancel,()=>{});
  const connection=app.connect(acp.ndJsonStream(agentToClient.writable,clientToAgent.readable));
  const client=new AcpSessionClient({id:"future",command:"fake",args:[]},async()=>({stream:acp.ndJsonStream(clientToAgent.writable,agentToClient.readable),exited:new Promise<number>(()=>{}),close:()=>connection.close()}),async(_request,signal)=>{expect(signal.aborted).toBe(false);entered();return decision;});
  const controller=new AbortController();await client.initialize(controller.signal);await client.createSession("/workspace",controller.signal);const prompt=client.prompt("go",controller.signal);await waiting;await client.cancel(new AbortController().signal);await expect(prompt).resolves.toMatchObject({stopReason:"end_turn"});expect(permission as acp.RequestPermissionResponse|null).toEqual({outcome:{outcome:"cancelled"}});resolveDecision({outcome:{outcome:"selected",optionId:"yes"}});await Bun.sleep(2);expect(permission as acp.RequestPermissionResponse|null).toEqual({outcome:{outcome:"cancelled"}});client.close();
});

test("宿主Resolver不能返回CLI未提供的权限选项",async()=>{
  const clientToAgent=new TransformStream<Uint8Array,Uint8Array>(),agentToClient=new TransformStream<Uint8Array,Uint8Array>();
  let permission:acp.RequestPermissionResponse|null=null;
  const app=acp.agent({name:"invalid-permission"}).onRequest(acp.methods.agent.initialize,()=>({protocolVersion:acp.PROTOCOL_VERSION,agentCapabilities:{}})).onRequest(acp.methods.agent.session.new,()=>({sessionId:"s"})).onRequest(acp.methods.agent.session.prompt,async context=>{permission=await context.client.request(acp.methods.client.session.requestPermission,{sessionId:"s",toolCall:{toolCallId:"t",kind:"edit",status:"pending",title:"Edit"},options:[{optionId:"yes",name:"Allow",kind:"allow_once"}]});return{stopReason:"end_turn"};});
  const connection=app.connect(acp.ndJsonStream(agentToClient.writable,clientToAgent.readable));const client=new AcpSessionClient({id:"future",command:"fake",args:[]},async()=>({stream:acp.ndJsonStream(clientToAgent.writable,agentToClient.readable),exited:new Promise<number>(()=>{}),close:()=>connection.close()}),async()=>({outcome:{outcome:"selected",optionId:"forged"}}));
  await client.initialize(new AbortController().signal);await client.createSession("/workspace",new AbortController().signal);await client.prompt("go",new AbortController().signal);expect(permission as acp.RequestPermissionResponse|null).toEqual({outcome:{outcome:"cancelled"}});client.close();
});

test("不声明反向文件与terminal能力，CLI不能通过宿主绕过OS工作区边界",async()=>{
 const clientToAgent=new TransformStream<Uint8Array,Uint8Array>(),agentToClient=new TransformStream<Uint8Array,Uint8Array>();let caps:acp.ClientCapabilities|undefined;
 const app=acp.agent({name:"no-file-delegate"}).onRequest(acp.methods.agent.initialize,context=>{caps=context.params.clientCapabilities;return{protocolVersion:acp.PROTOCOL_VERSION,agentCapabilities:{}};});
 const connection=app.connect(acp.ndJsonStream(agentToClient.writable,clientToAgent.readable));
 const client=new AcpSessionClient({id:"future",command:"fake",args:[]},async()=>({stream:acp.ndJsonStream(clientToAgent.writable,agentToClient.readable),exited:new Promise<number>(()=>{}),close:()=>connection.close()}));
 try{await client.initialize(new AbortController().signal);expect(caps?.fs).toEqual({readTextFile:false,writeTextFile:false});expect(caps?.terminal).toBe(false);}finally{client.close();}
});

test("ACP transport 退出时拒绝挂起的 prompt，而不是永久等待", async () => {
  let exitTransport!: (code: number) => void;
  const factory: AcpTransportFactory = async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "exit-acp" })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "acp-session" }))
      .onRequest(acp.methods.agent.session.prompt, () => new Promise<never>(() => {}));
    const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
      stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
      exited: new Promise<number>((resolve) => { exitTransport = resolve; }),
      close: () => connection.close(),
    };
  };
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, factory);
  await client.initialize(new AbortController().signal);
  await client.createSession("/workspace", new AbortController().signal);
  const pending = client.prompt("pending", new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  exitTransport(0);
  await expect(pending).rejects.toBeInstanceOf(AcpAmbiguousPromptError);
});
