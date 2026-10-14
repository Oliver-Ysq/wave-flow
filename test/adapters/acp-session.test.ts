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

test("ACP allow mode only selects an allow option offered by the Agent", async () => {
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
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }, { optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      return { stopReason: "end_turn" };
    });
  const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
  const client = new AcpSessionClient({ id: "fake", command: "fake", args: [] }, async () => ({ stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), exited: new Promise<number>(() => {}), close: () => connection.close() }), "allow");
  await client.initialize(new AbortController().signal);
  await client.createSession("/workspace", new AbortController().signal);
  await client.prompt("run", new AbortController().signal);
  expect(permission).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
  client.close();
});
