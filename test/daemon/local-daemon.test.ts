import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { RealCodexExecutor } from "../../src/runtime/real-codex-executor";
import type { DestroyResult, SessionBackend, SessionIdentity } from "../../src/sessions/types";

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

describe("LocalDaemon", () => {
  test("仅绑定 loopback，并经 API 创建 Journaled Run", async () => {
    const { cwd, workflowPath } = await fixture();
    const daemon = new LocalDaemon(true); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    expect(baseUrl).toStartWith("http://127.0.0.1:");
    const response = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: { target: "src" } }) });
    const body = await response.json() as { runId: string; snapshot: { status: string; phases: Array<{ agents: Array<{ result: unknown }> }> } };
    expect(response.status).toBe(200);
    expect(body.runId).toBeString();
    expect(body.snapshot).toMatchObject({ status: "completed", phases: [{ agents: [{ result: { nodeId: "scan-auth" } }] }] });
    const inspect = await fetch(`${baseUrl}/runs/${body.runId}?cwd=${encodeURIComponent(cwd)}`);
    await expect(inspect.json()).resolves.toMatchObject({ runId: body.runId, snapshot: { status: "completed" } });
  });

  test("拒绝非 loopback API 约定的错误方法、Content-Type 与请求内容", async () => {
    const daemon = new LocalDaemon(true); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    await expect(fetch(`${baseUrl}/runs`, { method: "GET" }).then((response) => response.status)).resolves.toBe(404);
    await expect(fetch(`${baseUrl}/runs`, { method: "POST", body: "{}" }).then((response) => response.status)).resolves.toBe(415);
    await expect(fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" }).then((response) => response.status)).resolves.toBe(400);
  });

  test("通过 loopback API 返回三态 capabilities 快照", async () => {
    const daemon = new LocalDaemon(true); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    const response = await fetch(`${baseUrl}/capabilities`);
    const snapshot = await response.json() as { version: number; host: { tmux: { status: string } }; adapters: { codex: { interactiveSession: string; verifiedPromptDelivery: string } } };
    expect(response.status).toBe(200);
    expect(snapshot.version).toBe(1);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.host.tmux.status);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.adapters.codex.interactiveSession);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.adapters.codex.verifiedPromptDelivery);
  });

  test("inspect 即使命中内存 Run 也要求请求 cwd 一致", async () => {
    const { cwd, workflowPath } = await fixture();
    const otherCwd = await mkdtemp(join(tmpdir(), "wave-flow-other-")); directories.push(otherCwd);
    const daemon = new LocalDaemon(true); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: { target: "src" } }) });
    const body = await created.json() as { runId: string };
    const inspect = await fetch(`${baseUrl}/runs/${body.runId}?cwd=${encodeURIComponent(otherCwd)}`);
    await expect(inspect.json()).resolves.toMatchObject({ error: "Run 不属于请求的项目 cwd。" });
    expect(inspect.status).toBe(400);
  });

  test("Workflow 运行中断后仍返回 RunId 和可 inspect 的 Journal 状态", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-daemon-")); directories.push(cwd);
    const workflowPath = join(cwd, "interrupted.ts");
    await writeFile(workflowPath, `import { agent } from "wave-flow";
export const meta = { name: "interrupted-flow", description: "Check interruption.", phases: [{ title: "scan" }] };
export default async function run(args: {}) { return agent("Review", { id: "scan", cli: "codex" }); }`, "utf8");
    const daemon = new LocalDaemon(true); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    const response = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: {} }) });
    const body = await response.json() as { runId: string; snapshot: { status: string } };
    expect(response.status).toBe(200);
    expect(body.runId).toBeString();
    expect(body.snapshot.status).toBe("interrupted");
  });

  test("真实 Control complete 会唤醒同一 POST /runs，并以 completed 响应返回", async () => {
    const { cwd, workflowPath } = await fixture();
    let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
    const backend: SessionBackend = {
      async create(value) {
        options = value;
        return identity(value.runId, value.nodeId, value.agentSessionId!);
      },
      async sendText() {}, async pasteText() {}, async sendSpecialKey() {},
      async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
      async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const daemon = new LocalDaemon({
      createRealExecutor: ({ controlUrl, runsRoot }) => new RealCodexExecutor(
        backend, controlUrl, runsRoot,
        async (_sessions, adapter, request) => {
          const plan = await adapter.launch(request, new AbortController().signal);
          const identity = await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile });
          return { identity };
        },
      ),
    });
    daemons.push(daemon);
    const { baseUrl } = daemon.start();
    const pending = fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: { target: "src" } }) });
    await waitFor(() => options !== null);
    const capability = options!.env?.WF_CONTROL_CAPABILITY;
    expect(capability).toBeString();
    const completed = await completeAfterSessionRecorded(baseUrl, options!.env!, capability!);
    expect(completed).toEqual({ ok: true });
    await expect(pending.then((response) => response.json())).resolves.toMatchObject({ snapshot: { status: "completed", phases: [{ agents: [{ status: "completed", result: { ok: true } }] }] } });
  });

});

function identity(runId: string, nodeId: string, agentSessionId: string): SessionIdentity {
  return { backend: "tmux", sessionName: "wf-daemon-test", backendRef: "/tmp/wf-daemon-test.sock", runId, nodeId, agentSessionId, cli: "codex", createdAt: new Date().toISOString() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待真实执行器启动超时。");
    await Bun.sleep(2);
  }
}

async function completeAfterSessionRecorded(baseUrl: string, environment: Readonly<Record<string, string>>, capability: string): Promise<{ ok: true }> {
  const deadline = Date.now() + 1_000;
  while (true) {
    const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(environment.WF_RUN_ID!)}/control/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: environment.WF_RUN_ID, nodeId: environment.WF_NODE_ID, agentSessionId: environment.WF_AGENT_SESSION_ID, capability, summary: "daemon e2e", result: { ok: true } }),
    });
    const value = await response.json() as { ok?: true; error?: string };
    if (response.ok) return value as { ok: true };
    if (value.error !== "首条任务投递的会话坐标尚未耐久记录，拒绝 complete。" || Date.now() >= deadline) throw new Error(value.error ?? `Control complete 返回 ${response.status}`);
    await Bun.sleep(2);
  }
}
