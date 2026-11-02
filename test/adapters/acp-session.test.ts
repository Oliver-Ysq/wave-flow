import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import * as acpUnstable from "@agentclientprotocol/sdk/unstable";
import { AcpAmbiguousPromptError, AcpSessionClient, type AcpTransportFactory } from "../../src/adapters/acp-session";

function fakeTransport(events: acp.SessionUpdate[], hooks: { cancelled: number; loaded: string[]; newSessionMeta?: Record<string, unknown>; replay?: acp.SessionUpdate[]; loadMcp?: unknown }): AcpTransportFactory {
  return async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "fake-acp" })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
      .onRequest(acp.methods.agent.session.new, (context) => { hooks.newSessionMeta = context.params._meta as Record<string, unknown> | undefined; return { sessionId: "acp-session" }; })
      .onRequest(acp.methods.agent.session.load, async (context) => {
        hooks.loaded.push(context.params.sessionId);
        hooks.loadMcp = context.params.mcpServers;
        for (const update of hooks.replay ?? []) {
          await context.client.notify(acp.methods.client.session.update, { sessionId: context.params.sessionId, update });
        }
        // 模拟 load 响应之后才到达的迟到重放：首个新 prompt 之前也必须丢弃。
        const late = hooks.replay?.[0];
        if (late) setTimeout(() => { void context.client.notify(acp.methods.client.session.update, { sessionId: context.params.sessionId, update: late }); }, 5);
        return {};
      })
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
test("load 时传入 MCP，并在首个新 prompt 前丢弃全部重放", async () => {
  const hooks = {
    cancelled: 0,
    loaded: [] as string[],
    replay: [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } } as acp.SessionUpdate],
    loadMcp: undefined as unknown,
  };
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, fakeTransport([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } },
  ], hooks));
  await client.initialize(new AbortController().signal);
  const received: acp.SessionUpdate[] = [];
  client.subscribe((event) => received.push(event.update));
  const server = { name: "wf", command: "/bin/true", args: [], env: [] } as acp.McpServer;
  await client.loadSession("saved", "/workspace", new AbortController().signal, [server]);
  await Bun.sleep(30);
  expect(hooks.loadMcp).toEqual([server]);
  expect(received).toEqual([]);
  await client.prompt("continue", new AbortController().signal);
  expect(received).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } }]);
  client.close();
});

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

test("仅注册 handler 的 Worker 广告并处理 Elicitation，Lead 不广告", async () => {
  const advertised: unknown[] = [];
  const factory: AcpTransportFactory = async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "elicitation-acp" })
      .onRequest(acp.methods.agent.initialize, (context) => { advertised.push(context.params.clientCapabilities); return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }; })
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "s" }))
      .onRequest(acp.methods.agent.session.prompt, async (context) => {
        const response = await context.client.request(acp.methods.client.elicitation.create, {
          sessionId: "s", mode: "form", message: "继续吗？",
          requestedSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        });
        expect(response).toEqual({ action: "accept", content: { ok: true } });
        return { stopReason: "end_turn" };
      });
    const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return { stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), exited: new Promise<number>(() => {}), close: () => connection.close() };
  };
  const lead = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, factory);
  await lead.initialize(new AbortController().signal);
  expect(advertised[0]).not.toHaveProperty("elicitation");
  lead.close();
  const worker = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, factory);
  worker.setElicitationResolver(async () => ({ action: "accept", content: { ok: true } }));
  await worker.initialize(new AbortController().signal);
  expect(advertised[1]).toMatchObject({ elicitation: { form: {} } });
  await worker.createSession("/workspace", new AbortController().signal);
  expect((await worker.prompt("ask", new AbortController().signal)).stopReason).toBe("end_turn");
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

/**
 * 客户端系统提示（ACP client-system-prompt）只在 Agent 于 initialize 声明
 * `sessionCapabilities.systemPrompt` 时才允许发送；声明了就必须在 new 与 load
 * 上重发同一份，否则会话回到 Agent 自己的默认指令。
 */
function systemPromptTransport(options: { readonly advertised: boolean; readonly received: Array<Record<string, unknown>>; readonly created: { count: number } }): AcpTransportFactory {
  return async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const capabilities = options.advertised
      ? { loadSession: true, sessionCapabilities: { systemPrompt: {} } }
      : { loadSession: true };
    // 假 Agent 用未稳定 schema 收请求：稳定 schema 会剥离未知字段，看不到 systemPrompt。
    const app = acpUnstable.agent({ name: "system-prompt-acp" })
      .onRequest(acpUnstable.methods.agent.initialize, () => ({ protocolVersion: acpUnstable.PROTOCOL_VERSION, agentCapabilities: capabilities as unknown as acp.AgentCapabilities }))
      .onRequest(acpUnstable.methods.agent.session.new, (context) => {
        options.created.count += 1;
        options.received.push(context.params as unknown as Record<string, unknown>);
        return { sessionId: "acp-session" };
      })
      .onRequest(acpUnstable.methods.agent.session.load, (context) => {
        options.received.push(context.params as unknown as Record<string, unknown>);
        return {};
      });
    const connection = app.connect(acpUnstable.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
      stream: acpUnstable.ndJsonStream(clientToAgent.writable, agentToClient.readable),
      exited: new Promise<number>(() => {}),
      close: () => connection.close(),
    };
  };
}

test("声明 systemPrompt 时在 session/new 与 session/load 重发同一份 append 文本", async () => {
  const received: Array<Record<string, unknown>> = [];
  const created = { count: 0 };
  const client = new AcpSessionClient(
    { id: "fake", command: "fake", args: [] },
    systemPromptTransport({ advertised: true, received, created }),
  );
  const signal = new AbortController().signal;
  await client.initialize(signal);
  expect(client.supportsClientSystemPrompt()).toBe(true);

  const systemPrompt = { mode: "append" as const, text: "  受管节点系统说明  " };
  await client.createSession("/workspace", signal, [], undefined, { systemPrompt });
  await client.loadSession("acp-session", "/workspace", signal, [], undefined, { systemPrompt });

  const expected = { mode: "append", content: [{ type: "text", text: "受管节点系统说明" }] };
  expect(received).toHaveLength(2);
  expect(received[0]!.systemPrompt).toEqual(expected);
  expect(received[1]!.systemPrompt).toEqual(expected);
  client.close();
});

test("未声明 systemPrompt 时拒绝发送，且不创建会话", async () => {
  const received: Array<Record<string, unknown>> = [];
  const created = { count: 0 };
  const client = new AcpSessionClient(
    { id: "fake", command: "fake", args: [] },
    systemPromptTransport({ advertised: false, received, created }),
  );
  const signal = new AbortController().signal;
  await client.initialize(signal);
  expect(client.supportsClientSystemPrompt()).toBe(false);

  await expect(
    client.createSession("/workspace", signal, [], undefined, { systemPrompt: { mode: "append", text: "说明" } }),
  ).rejects.toThrow("未声明 ACP sessionCapabilities.systemPrompt");
  // 拒绝发生在发送之前：不能出现“会话建好了但系统提示被静默丢掉”。
  expect(created.count).toBe(0);
  expect(received).toHaveLength(0);

  await expect(client.loadSession("acp-session", "/workspace", signal, [], undefined, { systemPrompt: { mode: "append", text: "说明" } }))
    .rejects.toThrow("未声明 ACP sessionCapabilities.systemPrompt");
  expect(received).toHaveLength(0);
  client.close();
});

test("即使声明能力，未请求时不发送 systemPrompt；空内容与超限一律拒绝", async () => {
  const received: Array<Record<string, unknown>> = [];
  const created = { count: 0 };
  const client = new AcpSessionClient(
    { id: "fake", command: "fake", args: [] },
    systemPromptTransport({ advertised: true, received, created }),
  );
  const signal = new AbortController().signal;
  await client.initialize(signal);

  await client.createSession("/workspace", signal);
  expect(received[0]).not.toHaveProperty("systemPrompt");

  await expect(client.createSession("/workspace", signal, [], undefined, { systemPrompt: { mode: "append", text: "   " } }))
    .rejects.toThrow("不能为空");
  await expect(client.createSession("/workspace", signal, [], undefined, { systemPrompt: { mode: "append", text: "x".repeat(16 * 1024 + 1) } }))
    .rejects.toThrow("超过 16KiB");
  // 三次失败请求都在发送前被拒：只有第一次真正建立了会话。
  expect(created.count).toBe(1);
  client.close();
});
