import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { RealCodexExecutor } from "../../src/runtime/real-codex-executor";
import type { DestroyResult, SessionBackend, SessionIdentity } from "../../src/sessions/types";
import { runsRoot } from "../../src/journal/paths";
import { DaemonClient } from "../../src/cli/daemon-client";

const directories: string[] = [];
const daemons: LocalDaemon[] = [];
afterEach(async () => { daemons.splice(0).forEach((daemon) => daemon.stop()); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture(): Promise<{ cwd: string; workflowPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-daemon-")); directories.push(cwd);
  const workflowPath = join(cwd, "workflow file.ts");
  await writeFile(workflowPath, `import { agent, phase } from "wave-flow";
export const meta = { name: "daemon-check", description: "Check daemon.", phases: [{ title: "scan" }] };
export default async function run(args: { target: string }) { phase("scan"); return agent("Review", { id: "scan-auth", cli: "codex", input: { target: args.target } }); }`, "utf8");
  return { cwd, workflowPath };
}

async function testDaemon(options: ConstructorParameters<typeof LocalDaemon>[0] = true): Promise<LocalDaemon> {
  const store = await mkdtemp(join(tmpdir(), "wave-flow-store-")); directories.push(store);
  const normalized = typeof options === "boolean" ? { deterministicForTest: options } : options;
  const daemon = new LocalDaemon({ ...normalized, storeRoot: runsRoot(store) });
  daemons.push(daemon);
  return daemon;
}

describe("LocalDaemon", () => {
  test("新 daemon 从 Journal 重建旧 running 会话后，可凭稳定身份完成且不创建新 Agent", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    let launches = 0;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const store = await mkdtemp(join(tmpdir(), "wave-flow-reclaim-store-")); directories.push(store);
    const first = new LocalDaemon({ storeRoot: runsRoot(store), createRealExecutor: ({ controlUrl, runsRoot: root }) => new RealCodexExecutor(backend, controlUrl, root, async (_sessions, adapter, request) => {
      launches += 1;
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    daemons.push(first);
    const firstServer = first.start();
    const created = await fetch(`${firstServer.baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    const env = options!.env!;
    first.stop();
    const second = new LocalDaemon({ storeRoot: runsRoot(store), verifyReclaimSession: async () => true });
    daemons.push(second);
    const secondServer = second.start();
    const response = await fetch(`${secondServer.baseUrl}/runs/${created.runId}/control/reclaim-complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: env.WF_RUN_ID, nodeId: env.WF_NODE_ID, agentSessionId: env.WF_AGENT_SESSION_ID, summary: "reclaimed", result: { ok: true } }) });
    expect(response.status).toBe(200);
    expect(launches).toBe(1);
    // 控制恢复只接受旧 Agent 的完成事实；旧 Runtime 调用栈不在，不能伪造 Run
    // 已封存或自动创建下游节点。用户 resume 后才会进行调用级重放与聚合收尾。
    await expect(fetch(`${secondServer.baseUrl}/runs/${created.runId}`).then((value) => value.json())).resolves.toMatchObject({ snapshot: { status: "running", phases: [{ agents: [{ status: "completed", result: { ok: true } }] }] } });
  });

  test("未知稳定身份或旧会话验证失败时不允许完成", async () => {
    const { cwd, workflowPath } = await fixture();
    const store = await mkdtemp(join(tmpdir(), "wave-flow-reclaim-store-")); directories.push(store);
    const daemon = new LocalDaemon({ storeRoot: runsRoot(store), verifyReclaimSession: async () => false });
    daemons.push(daemon);
    const server = daemon.start();
    // 没有对应 Journal 会话的稳定身份请求必须 fail-closed；不创建 Run 或节点。
    const response = await fetch(`${server.baseUrl}/runs/11111111-1111-4111-8111-111111111111/control/reclaim-complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "11111111-1111-4111-8111-111111111111", nodeId: "node", agentSessionId: "session", summary: "bad", result: { ok: true } }) });
    expect(response.status).toBe(400);
    void cwd; void workflowPath;
  });

  test("answer 可按全局 blockRequestId 路由到正确 Run，而不要求用户提供 runId", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    // 用真实受管环境发起 block；HTTP route 的 answer 不携带 runId。
    const requestId = crypto.randomUUID();
    const block = fetch(`${baseUrl}/runs/${created.runId}/control/block`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockRequestId: requestId, runId: options!.env!.WF_RUN_ID, nodeId: options!.env!.WF_NODE_ID, agentSessionId: options!.env!.WF_AGENT_SESSION_ID, needHelp: "需要人工确认" }) });
    await waitForAsync(async () => (await fetch(`${baseUrl}/runs/${created.runId}`).then((response) => response.json() as Promise<{ snapshot: { phases: Array<{ agents: Array<{ status: string }> }> } }>)).snapshot.phases[0]?.agents[0]?.status === "blocked");
    const answer = await fetch(`${baseUrl}/blocks/${requestId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { approved: true } }) });
    expect(answer.status).toBe(200);
    await expect(block.then((response) => response.json())).resolves.toEqual({ blockRequestId: requestId, answer: { approved: true } });
  });

  test("daemon 重启后先 answer 再由同一 blockRequestId 重连，且只有 continue 恢复节点", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    let launches = 0;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const store = await mkdtemp(join(tmpdir(), "wave-flow-block-reclaim-store-")); directories.push(store);
    const first = new LocalDaemon({ storeRoot: runsRoot(store), createRealExecutor: ({ controlUrl, runsRoot: root }) => new RealCodexExecutor(backend, controlUrl, root, async (_sessions, adapter, request) => {
      launches += 1;
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    daemons.push(first);
    const firstServer = first.start();
    const created = await fetch(`${firstServer.baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    const env = options!.env!;
    const requestId = crypto.randomUUID();
    const body = { blockRequestId: requestId, runId: env.WF_RUN_ID, nodeId: env.WF_NODE_ID, agentSessionId: env.WF_AGENT_SESSION_ID, needHelp: "需要人工确认" };
    const oldBlock = fetch(`${firstServer.baseUrl}/runs/${created.runId}/control/block`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await waitForAsync(async () => (await fetch(`${firstServer.baseUrl}/runs/${created.runId}`).then((response) => response.json() as Promise<{ snapshot: { phases: Array<{ agents: Array<{ status: string }> }> } }>)).snapshot.phases[0]?.agents[0]?.status === "blocked");
    first.stop();
    // 旧 HTTP 等待已经不再可信；新 daemon 先从 Journal 重建并保存用户答案。
    await oldBlock.catch(() => undefined);
    const second = new LocalDaemon({ storeRoot: runsRoot(store), verifyReclaimSession: async () => true });
    daemons.push(second);
    const secondServer = second.start();
    const answer = await fetch(`${secondServer.baseUrl}/blocks/${requestId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { approved: true } }) });
    expect(answer.status).toBe(200);
    const reconnected = await fetch(`${secondServer.baseUrl}/runs/${created.runId}/control/block`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expect(reconnected.json()).resolves.toEqual({ blockRequestId: requestId, answer: { approved: true } });
    const opened = await (await import("../../src/journal/run-journal")).RunJournal.open(created.runId, runsRoot(store));
    expect(opened.events.filter((event) => event.type === "block.created")).toHaveLength(1);
    expect(opened.events.filter((event) => event.type === "block.answered")).toHaveLength(1);
    await expect(fetch(`${secondServer.baseUrl}/runs/${created.runId}`).then((response) => response.json())).resolves.toMatchObject({ snapshot: { phases: [{ agents: [{ status: "blocked", block: { answered: true } }] }] } });
    const continued = await fetch(`${secondServer.baseUrl}/runs/${created.runId}/control/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, blockRequestId: requestId }) });
    expect(continued.status).toBe(200);
    expect(launches).toBe(1);
    await expect(fetch(`${secondServer.baseUrl}/runs/${created.runId}`).then((response) => response.json())).resolves.toMatchObject({ snapshot: { phases: [{ agents: [{ status: "running" }] }] } });
  });
  test("仅绑定 loopback，并经 API 创建 Journaled Run", async () => {
    const { cwd, workflowPath } = await fixture();
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    expect(baseUrl).toStartWith("http://127.0.0.1:");
    const response = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) });
    const body = await response.json() as { runId: string; snapshot: { status: string; phases: Array<{ agents: Array<{ result: unknown }> }> } };
    expect(response.status).toBe(200);
    expect(body.runId).toBeString();
    expect(body.snapshot).toMatchObject({ status: "completed", phases: [{ agents: [{ result: { nodeId: "scan-auth" } }] }] });
    const inspect = await fetch(`${baseUrl}/runs/${body.runId}?cwd=${encodeURIComponent(cwd)}`);
    await expect(inspect.json()).resolves.toMatchObject({ runId: body.runId, snapshot: { status: "completed" } });
  });

  test("resume 拒绝已封存 Run", async () => {
    const { cwd, workflowPath } = await fixture();
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    const completed = await fetch(`${baseUrl}/runs/${created.runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorized: true }) });
    expect(completed.status).toBe(400);
  });

  test("resume 要求显式授权，且拒绝接管当前 daemon 正在执行的 Run", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    const unapproved = await fetch(`${baseUrl}/runs/${created.runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(unapproved.status).toBe(400);
    const active = await fetch(`${baseUrl}/runs/${created.runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorized: true }) });
    expect(active.status).toBe(409);
  });

  test("用户 resume 将不可验证的旧 running 会话标记 interrupted 后创建新 attempt", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const store = await mkdtemp(join(tmpdir(), "wave-flow-resume-store-")); directories.push(store);
    const first = new LocalDaemon({ storeRoot: runsRoot(store), createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    daemons.push(first);
    const firstServer = first.start();
    const created = await fetch(`${firstServer.baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    first.stop();
    const second = new LocalDaemon({ deterministicForTest: true, storeRoot: runsRoot(store), verifyReclaimSession: async () => false });
    daemons.push(second);
    const secondServer = second.start();
    const resume = () => fetch(`${secondServer.baseUrl}/runs/${created.runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorized: true }) });
    const [left, right] = await Promise.all([resume(), resume()]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    await left.json(); await right.json();
    await expect(waitForCompletedRun(secondServer.baseUrl, created.runId)).resolves.toMatchObject({ snapshot: { status: "completed", phases: [{ agents: [{ status: "completed" }] }] } });
    const opened = await (await import("../../src/journal/run-journal")).RunJournal.open(created.runId, runsRoot(store));
    expect(opened.events.some((event) => event.type === "agent.status" && event.status === "interrupted" && event.diagnostic === "用户显式 resume 时旧会话无法验证。")).toBe(true);
    expect(opened.events.filter((event) => event.type === "agent.restarted")).toHaveLength(1);
  });

  test("相同 clientRequestId 的并发创建只返回同一个 Run", async () => {
    const { cwd, workflowPath } = await fixture();
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    const body = JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } });
    const request = () => fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((response) => response.json() as Promise<{ runId: string }>);
    const [left, right] = await Promise.all([request(), request()]);
    expect(left.runId).toBe(right.runId);
  });

  test("已返回 running 后以相同 clientRequestId 重试，仍返回内存中的同一个 Run", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const body = JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } });
    const first = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((response) => response.json() as Promise<{ runId: string; snapshot: { status: string } }>);
    await waitFor(() => options !== null);
    const retry = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body });
    await expect(retry.json()).resolves.toMatchObject({ runId: first.runId, snapshot: { status: "running" } });
    await completeAfterSessionRecorded(baseUrl, options!.env!);
  });

  test("全局运行中 Run 达到护栏时拒绝新建", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ maxActiveRuns: 1, createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const first = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) });
    expect(first.status).toBe(200);
    await waitFor(() => options !== null);
    const second = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ error: "全局运行中 Run 已达到上限：1。" });
  });

  test("全局 Agent 名额已满时立即返回 queued 快照，而不等待首个会话", async () => {
    const { cwd, workflowPath } = await fixture();
    let created = 0;
    const backend: SessionBackend = {
      async create(value) { created += 1; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ maxActiveRuns: 2, maxActiveAgents: 1, createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const post = () => fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string; snapshot: { phases: Array<{ agents: Array<{ status: string }> }> } }>);
    const first = await post();
    await waitFor(() => created === 1);
    const second = await Promise.race([post(), Bun.sleep(500).then(() => { throw new Error("queued Run 未及时返回"); })]);
    expect(second.snapshot.phases[0]?.agents[0]?.status).toBe("queued");
    // 后台第一个节点仍占用唯一名额，第二个不能提前创建真实会话。
    expect(created).toBe(1);
    const firstOptions = await fetch(`${baseUrl}/runs/${first.runId}`).then((response) => response.json()) as { snapshot: { phases: Array<{ agents: Array<{ agentSessionId: string | null }> }> } };
    const firstNode = firstOptions.snapshot.phases[0]?.agents[0];
    // 清理第一个 Run，避免其未完成会话拖住 afterEach；直接停止 daemon 即可。
    expect(firstNode?.agentSessionId).toBeString();
  });

  test("Run 事件流推送权威快照，并在 completed 后关闭", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    const stream = await fetch(`${baseUrl}/runs/${created.runId}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reading = new Response(stream.body!).text();
    await completeAfterSessionRecorded(baseUrl, options!.env!);
    const text = await reading;
    expect(text).toContain('"status":"running"');
    expect(text).toContain('"status":"completed"');
  });

  test("SSE 提前断开时客户端回查 completed 快照，而不把正常完成报错", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({ createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(backend, controlUrl, runsRoot, async (_sessions, adapter, request) => {
      const plan = await adapter.launch(request, new AbortController().signal);
      return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
    }) });
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) }).then((response) => response.json() as Promise<{ runId: string }>);
    await waitFor(() => options !== null);
    const stream = await fetch(`${baseUrl}/runs/${created.runId}/events`);
    const reader = stream.body!.getReader();
    await reader.read();
    await reader.cancel();
    await completeAfterSessionRecorded(baseUrl, options!.env!);
    const seen: string[] = [];
    await new DaemonClient(baseUrl).followRun(created.runId, (response) => seen.push(response.snapshot.status), new AbortController().signal);
    expect(seen).toContain("completed");
  });

  test("拒绝非 loopback API 约定的错误方法、Content-Type 与请求内容", async () => {
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    await expect(fetch(`${baseUrl}/runs`, { method: "GET" }).then((response) => response.status)).resolves.toBe(404);
    await expect(fetch(`${baseUrl}/runs`, { method: "POST", body: "{}" }).then((response) => response.status)).resolves.toBe(415);
    await expect(fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" }).then((response) => response.status)).resolves.toBe(400);
  });

  test("通过 loopback API 返回三态 capabilities 快照", async () => {
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    const response = await fetch(`${baseUrl}/capabilities`);
    const snapshot = await response.json() as { version: number; host: { tmux: { status: string } }; adapters: { codex: { interactiveSession: string; verifiedPromptDelivery: string } } };
    expect(response.status).toBe(200);
    expect(snapshot.version).toBe(1);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.host.tmux.status);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.adapters.codex.interactiveSession);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.adapters.codex.verifiedPromptDelivery);
  });

  test("inspect 命中内存 Run 时不再依赖项目 cwd", async () => {
    const { cwd, workflowPath } = await fixture();
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) });
    const body = await created.json() as { runId: string };
    const inspect = await fetch(`${baseUrl}/runs/${body.runId}`);
    await expect(inspect.json()).resolves.toMatchObject({ runId: body.runId, snapshot: { status: "completed" } });
    expect(inspect.status).toBe(200);
  });

  test("Workflow 运行中断后仍返回 RunId 和可 inspect 的 Journal 状态", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-daemon-")); directories.push(cwd);
    const workflowPath = join(cwd, "interrupted.ts");
    await writeFile(workflowPath, `import { agent } from "wave-flow";
export const meta = { name: "interrupted-flow", description: "Check interruption.", phases: [{ title: "scan" }] };
export default async function run(args: {}) { return agent("Review", { id: "scan", cli: "codex" }); }`, "utf8");
    const daemon = await testDaemon();
    const { baseUrl } = daemon.start();
    const response = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: {} }) });
    const body = await response.json() as { runId: string; snapshot: { status: string } };
    expect(response.status).toBe(200);
    expect(body.runId).toBeString();
    expect(body.snapshot.status).toBe("interrupted");
  });

  test("真实 Control complete 在 POST /runs 已返回 running 后完成同一 Run", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) {
        options = value;
        return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash);
      },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {},
      async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = await testDaemon({
      createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(
        backend, controlUrl, runsRoot,
        async (_sessions, adapter, request) => {
          const plan = await adapter.launch(request, new AbortController().signal);
          const identity = await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash });
          return { identity };
        },
      ),
    });
    const { baseUrl } = daemon.start();
    const pending = fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: { target: "src" } }) });
    await waitFor(() => options !== null);
    expect(options!.env?.WF_RECLAIM_TOKEN).toBeUndefined();
    const created = await pending.then((response) => response.json());
    expect(created).toMatchObject({ snapshot: { status: "running", phases: [{ agents: [{ status: "running" }] }] } });
    const completed = await completeAfterSessionRecorded(baseUrl, options!.env!);
    expect(completed).toEqual({ ok: true });
    await expect(waitForCompletedRun(baseUrl, options!.env!.WF_RUN_ID!)).resolves.toMatchObject({ snapshot: { status: "completed", phases: [{ agents: [{ status: "completed", result: { ok: true } }] }] } });
  });

});

function identity(runId: string, nodeId: string, agentSessionId: string, reclaimTokenHash?: string): SessionIdentity {
  return { backend: "tmux", sessionName: "wf-daemon-test", backendRef: "/tmp/wf-daemon-test.sock", runId, nodeId, agentSessionId, cli: "codex", createdAt: new Date().toISOString(), ...(reclaimTokenHash ? { reclaimTokenHash } : {}) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待真实执行器启动超时。");
    await Bun.sleep(2);
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("等待异步条件超时。");
    await Bun.sleep(2);
  }
}

async function completeAfterSessionRecorded(baseUrl: string, environment: Readonly<Record<string, string>>): Promise<{ ok: true }> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(environment.WF_RUN_ID!)}/control/reclaim-complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: environment.WF_RUN_ID, nodeId: environment.WF_NODE_ID, agentSessionId: environment.WF_AGENT_SESSION_ID, summary: "daemon e2e", result: { ok: true } }),
    });
    const value = await response.json() as { ok?: true; error?: string };
    if (response.ok) return value as { ok: true };
    if (value.error !== "首条任务投递的会话坐标尚未耐久记录，拒绝 complete。" || Date.now() >= deadline) throw new Error(value.error ?? `Control complete 返回 ${response.status}`);
    await Bun.sleep(2);
  }
}

async function waitForCompletedRun(baseUrl: string, runId: string): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = await fetch(`${baseUrl}/runs/${runId}`).then((response) => response.json()) as { snapshot?: { status?: string } };
    if (value.snapshot?.status === "completed") return value;
    if (Date.now() >= deadline) throw new Error("等待 Run 封存 completed 超时。");
    await Bun.sleep(2);
  }
}
