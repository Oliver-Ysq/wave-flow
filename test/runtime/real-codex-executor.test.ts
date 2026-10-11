import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ControlServer } from "../../src/control/control-server";
import { RunJournal } from "../../src/journal/run-journal";
import { runsRoot } from "../../src/journal/paths";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { RealCodexExecutor } from "../../src/runtime/real-codex-executor";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { CreateSessionOptions, DestroyResult, SessionBackend, SessionIdentity, SessionLiveness } from "../../src/sessions/types";
import { CodexAppServerAmbiguousSubmissionError } from "../../src/adapters/codex-app-server";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-real-executor-")); directories.push(cwd);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "real", description: "Real.", phases: [{ title: "run" }] }, workflowHash: "b".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, cwd, sandbox: "workspace-write" as const, prompt: "complete with JSON", phase: "run" };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const agentSessionId = "agent-session";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  const node = state.agent("node");
  const control = new ControlServer(journal, state);
  return { cwd, manifest, journal, state, node, control, agentSessionId };
}

describe("RealCodexExecutor", () => {
  test("启动前要求 tmux 私有会话和 Codex 二进制均明确可用", () => {
    const executor = new RealCodexExecutor(missingSessions(), "http://127.0.0.1:9999", "/tmp/runs");
    const requirements = executor.requiredCapabilities();
    const available = { version: 1 as const, host: { platform: "test", tmux: { status: "available" as const, persistentSessions: "available" as const } }, adapters: { codex: { status: "available" as const, interactiveSession: "unknown" as const, verifiedPromptDelivery: "unknown" as const, persistentTmuxSession: "unknown" as const, sandbox: { readOnly: "unknown" as const, workspaceWrite: "unknown" as const } } } };
    expect(requirements["tmux.persistentSessions"]?.(available)).toBe("available");
    expect(requirements["codex.binary"]?.(available)).toBe("available");
    expect(requirements["tmux.persistentSessions"]?.({ ...available, host: { ...available.host, tmux: { ...available.host.tmux, persistentSessions: "unknown" } } })).toBe("unknown");
  });

  test("构造时省略策略也默认使用 App Server hybrid", async () => {
    const value = await fixture();
    let hybridStarts = 0;
    const executor = new RealCodexExecutor(
      missingSessions(), "http://127.0.0.1:9999", runsRoot(value.cwd),
      async () => { throw new Error("默认策略不应启动普通 tmux 投递"); }, 1,
      undefined,
      async (_backend, node, _prompt, _file, _env, hash) => { hybridStarts += 1; return { identity: identity(value.manifest.runId, node.agentSessionId!, hash), binding: { endpoint: "ws://127.0.0.1:9999", threadId: "thread", turnId: "turn" }, stop() {} }; },
    );
    executor.bindControl(value.control);
    await expect(executor.execute(value.node)).rejects.toThrow("无法继续验证");
    expect(hybridStarts).toBe(1);
  });

  test("先注册 capability 再启动会话，complete 后 executor 返回结果", async () => {
    const value = await fixture();
    const capture: { createOptions: CreateSessionOptions | null } = { createOptions: null };
    const sessions: SessionBackend = {
      async create(options) { capture.createOptions = options; return identity(value.manifest.runId, value.agentSessionId, options.reclaimTokenHash); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return readyScreen; }, async liveness() { return "exists" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    let submittedPrompt = "";
    const executor = new RealCodexExecutor(sessions, "http://127.0.0.1:9999", runsRoot(value.cwd), async (backend, adapter, request) => {
      submittedPrompt = request.prompt;
      const plan = await adapter.launch(request, new AbortController().signal);
      const identity = await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId ?? undefined, cli: request.node.cli, cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash });
      return { identity };
    }, 1_000, false);
    executor.bindControl(value.control);
    const completing = executor.execute(value.node);
    await waitFor(() => capture.createOptions !== null);
    expect(capture.createOptions?.agentSessionId).toBe(value.agentSessionId);
    expect(capture.createOptions?.env).toMatchObject({ WF_RUN_ID: value.manifest.runId, WF_NODE_ID: "node", WF_AGENT_SESSION_ID: value.agentSessionId });
    const reclaimToken = capture.createOptions?.env?.WF_RECLAIM_TOKEN;
    expect(reclaimToken).toBeUndefined();
    expect(capture.createOptions?.env?.WF_CONTROL_URL).toBeUndefined();
    expect(capture.createOptions?.env?.WF_CONTROL_CAPABILITY).toBeUndefined();
    expect(capture.createOptions?.reclaimTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(submittedPrompt).toContain(`--run-id ${value.manifest.runId} --node-id node --agent-session-id ${value.agentSessionId}`);
    expect(submittedPrompt).toContain("wave-flow block");
    expect(submittedPrompt).toContain("wave-flow continue");
    expect(submittedPrompt).toContain("wave-flow complete");
    await waitFor(async () => {
      const reopened = await RunJournal.open(value.manifest.runId, runsRoot(value.cwd));
      return reopened.events.some((event) => event.type === "agent.session" && event.nodeId === "node" && event.agentSessionId === value.agentSessionId);
    });
    await value.control.completeReclaimed({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.agentSessionId, summary: "done", result: { ok: true } });
    await expect(completing).resolves.toEqual({ ok: true });
  });

  test("会话 liveness 无法验证时中断等待并撤销 capability", async () => {
    const value = await fixture();
    const sessions: SessionBackend = {
      async create(options) { return identity(value.manifest.runId, value.agentSessionId, options.reclaimTokenHash); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return readyScreen; }, async liveness() { return "unknown" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const executor = new RealCodexExecutor(sessions, "http://127.0.0.1:9999", runsRoot(value.cwd), async (_backend, _adapter, request) => ({ identity: identity(request.runId, value.agentSessionId, request.reclaimTokenHash) }), 1, false);
    executor.bindControl(value.control);
    await expect(executor.execute(value.node)).rejects.toThrow("无法继续验证：unknown");
    await expect(value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: "anything", summary: "done", result: { ok: true } })).rejects.toThrow("不匹配");
  });

  test("SessionBackend 未回传会话标记 hash 时 fail-closed", async () => {
    const value = await fixture();
    const sessions: SessionBackend = {
      async create() { return identity(value.manifest.runId, value.agentSessionId); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return readyScreen; }, async liveness() { return "exists" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const executor = new RealCodexExecutor(sessions, "http://127.0.0.1:9999", runsRoot(value.cwd), async (_backend, _adapter, request) => ({ identity: identity(request.runId, value.agentSessionId) }), 1, false);
    executor.bindControl(value.control);
    await expect(executor.execute(value.node)).rejects.toThrow("reclaim token hash");
  });

  test("codexRpcInput 成功时使用 hybrid 启动，不调用普通 tmux paste 启动", async () => {
    const value = await fixture();
    let ordinaryStarts = 0;
    let hybridStarts = 0;
    const sessions = missingSessions();
    const executor = new RealCodexExecutor(
      sessions, "http://127.0.0.1:9999", runsRoot(value.cwd),
      async () => { ordinaryStarts += 1; throw new Error("ordinary should not run"); },
      1, true,
      async (_backend, node, _prompt, _identityFile, env, hash) => { hybridStarts += 1; expect(env.WF_AGENT_SESSION_ID).toBe(value.agentSessionId); return { identity: identity(value.manifest.runId, node.agentSessionId!, hash), binding: { endpoint: "ws://127.0.0.1:9999/", threadId: "thread", turnId: "turn" }, stop() {} }; },
    );
    executor.bindControl(value.control);
    const completing = executor.execute(value.node);
    const interrupted = expect(completing).rejects.toThrow("无法继续验证");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hybridStarts).toBe(1);
    expect(ordinaryStarts).toBe(0);
    await interrupted;
  });

  test("codexRpcInput 的首条 RPC 已发出但不明时不回退普通模式", async () => {
    const value = await fixture();
    let ordinaryStarts = 0;
    const executor = new RealCodexExecutor(
      missingSessions(), "http://127.0.0.1:9999", runsRoot(value.cwd),
      async () => { ordinaryStarts += 1; throw new Error("must not fallback"); },
      1, true,
      async () => { throw new CodexAppServerAmbiguousSubmissionError("ambiguous"); },
    );
    executor.bindControl(value.control);
    await expect(executor.execute(value.node)).rejects.toBeInstanceOf(CodexAppServerAmbiguousSubmissionError);
    expect(ordinaryStarts).toBe(0);
  });

  test("App Server 已启动后异常退出时中断节点，即使 viewer 仍显示存活", async () => {
    const value = await fixture();
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const executor = new RealCodexExecutor(
      { ...missingSessions(), async liveness() { return "exists" as SessionLiveness; } },
      "http://127.0.0.1:9999", runsRoot(value.cwd),
      async () => { throw new Error("不应回退普通投递"); }, 1, true,
      async (_backend, node, _prompt, _identityFile, _env, hash) => ({ identity: identity(value.manifest.runId, node.agentSessionId!, hash), binding: { endpoint: "ws://127.0.0.1:9999", threadId: "thread", turnId: "turn" }, exited, stop() {} }),
    );
    executor.bindControl(value.control);
    const running = executor.execute(value.node);
    await new Promise((resolve) => setTimeout(resolve, 5));
    exit(23);
    await expect(running).rejects.toThrow("App Server 进程已退出：23");
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("等待真实执行器创建会话超时。");
    await Bun.sleep(5);
  }
}

function identity(runId: string, agentSessionId: string, reclaimTokenHash?: string): SessionIdentity {
  return { backend: "tmux", sessionName: "wf-test", backendRef: "/tmp/socket", runId, nodeId: "node", agentSessionId, cli: "codex", createdAt: new Date().toISOString(), ...(reclaimTokenHash ? { reclaimTokenHash } : {}) };
}

const readyScreen = "╭────────╮\n│ model: test │\n│ directory: /tmp │\n╰────────╯\n› Ask Codex to do anything\ntest · /tmp";

function missingSessions(): SessionBackend {
  return { async create() { throw new Error("not used"); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "unknown" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; } };
}
