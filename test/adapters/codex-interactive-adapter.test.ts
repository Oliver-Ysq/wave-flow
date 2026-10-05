import { afterEach, describe, expect, test } from "bun:test";
import { CodexInteractiveAdapter } from "../../src/adapters/codex-interactive-adapter";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { SessionIdentity } from "../../src/sessions/types";
import type { CreateSessionOptions, DestroyResult, SessionBackend, SessionLiveness } from "../../src/sessions/types";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveCliBootstrap } from "../../src/sessions/bootstrap/interactive-cli-bootstrap";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function node(overrides: Partial<AgentNodeSnapshot> = {}): AgentNodeSnapshot {
  return {
    id: "review", phase: "scan", sequence: 1, cli: "codex", sandbox: "read-only", cwd: "/workspace/project", label: "Review", status: "running", result: null, diagnostic: null,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, agentSessionId: null,
    request: { id: "review", cli: "codex", cwd: "/workspace/project", sandbox: "read-only", prompt: "检查变更", phase: "scan" },
    ...overrides,
  };
}

class RecordingBackend implements SessionBackend {
  readonly pasted: string[] = [];
  readonly keys: string[] = [];
  screen = readyScreen();
  async create(_options: CreateSessionOptions): Promise<SessionIdentity> { return identityFor("review"); }
  async sendText(): Promise<void> {}
  async pasteText(_identity: SessionIdentity, text: string): Promise<void> { this.pasted.push(text); }
  async sendSpecialKey(_identity: SessionIdentity, key: "Enter"): Promise<void> { this.keys.push(key); }
  async readRecent(): Promise<string> { return this.screen; }
  async liveness(): Promise<SessionLiveness> { return "exists"; }
  async detach(): Promise<void> {}
  async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; }
}

function identityFor(nodeId: string): SessionIdentity { return { backend: "tmux", sessionName: "wf-test", backendRef: "/tmp/wf.sock", runId: "11111111-1111-4111-8111-111111111111", nodeId, agentSessionId: "agent", cli: "codex", createdAt: "2026-01-01T00:00:00.000Z" }; }
function readyScreen(cwd = "/workspace/project"): string { return `╭─ >_ OpenAI Codex ─╮\n│ model: gpt │\n│ directory: ${cwd} │\n╰─────────────────────╯\n› Ask Codex to do anything\ngpt · ${cwd}`; }
function currentReadyScreen(cwd = "/workspace/project"): string { return `>_ OpenAI Codex (v0.159.2)\n${cwd}\n\n› Ask Codex to do anything\n\nGPT-6.1-Sol default · ${cwd}`; }

describe("CodexInteractiveAdapter", () => {
  test("只构造空启动的正常交互式 codex argv，不将 Prompt 放入位置参数", () => {
    const adapter = new CodexInteractiveAdapter(new RecordingBackend(), { command: "codex-test" });
    expect(adapter.commandFor({ node: node({ sandbox: "workspace-write", request: { ...node().request, model: "gpt-test" } }), prompt: "修复 '引号'\n并检查" })).toEqual([
      "codex-test", "-c", 'projects={"/workspace/project"={trust_level="trusted"}}', "--no-daemon", "--sandbox", "workspace-write", "--cd", "/workspace/project", "--no-alt-screen", "--model", "gpt-test",
    ]);
  });

  test("首条 Prompt 仅在 Ready 后经 bracketed paste 与 Enter 提交，不进入启动 argv", async () => {
    const backend = new RecordingBackend(); const adapter = new CodexInteractiveAdapter(backend);
    const plan = await adapter.launch({ runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/.wave-flow/session.json" }, new AbortController().signal);
    expect(plan.command).toEqual(["codex", "-c", 'projects={"/workspace/project"={trust_level="trusted"}}', "--no-daemon", "--sandbox", "read-only", "--cd", "/workspace/project", "--no-alt-screen"]);
    await expect(adapter.waitUntilReady({ runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/.wave-flow/session.json" }, plan, identityFor("review"), new AbortController().signal)).resolves.toMatchObject({ ready: true });
    await expect(adapter.submitInitialPrompt({ runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/.wave-flow/session.json" }, plan, identityFor("review"), new AbortController().signal)).resolves.toBeUndefined();
    expect(backend.pasted).toHaveLength(1);
    expect(backend.pasted[0]).toMatch(/^检查变更\n\n\[Wave Flow 内部关联标识：wf-submit:[0-9a-f-]{36}\]$/);
    expect(backend.keys).toEqual(["Enter"]);
  });

  test("拒绝非 Codex 节点和空 Prompt", () => {
    const adapter = new CodexInteractiveAdapter(new RecordingBackend());
    expect(() => adapter.commandFor({ node: node({ cli: "traex" as never }), prompt: "任务" })).toThrow("cli: codex");
    expect(() => adapter.commandFor({ node: node(), prompt: " " })).toThrow("非空");
  });

  test("仅确认 history 基线之后完整、精确匹配且带 session_id 的原生记录", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-history-")); directories.push(cwd);
    const history = join(cwd, "history.jsonl");
    await writeFile(history, `${JSON.stringify({ text: "旧任务", session_id: "old" })}\n`, "utf8");
    const adapter = new CodexInteractiveAdapter(new RecordingBackend(), { command: "codex", historyPath: history, historyPollMs: 1, pasteSettleMs: 1, confirmationAttemptMs: 10 });
    const request = { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: join(cwd, "session.json") } as const;
    const plan = await adapter.launch(request, new AbortController().signal);
    const prompt = (plan.submissionContext as { submittedPrompt: string }).submittedPrompt;
    await adapter.submitInitialPrompt(request, plan, identityFor("review"), new AbortController().signal);
    await writeFile(history, `${JSON.stringify({ text: "检查变更", session_id: "foreign" })}\n${JSON.stringify({ text: prompt })}\n${JSON.stringify({ text: prompt, session_id: "codex-session" })}\n`, { encoding: "utf8", flag: "a" });
    await expect(adapter.confirmInitialPrompt(request, plan, identityFor("review"), new AbortController().signal)).resolves.toEqual({ submitted: true, proof: "native-history", cliSessionId: "codex-session", diagnostic: "已确认 Codex 原生 history 提交记录。" });
  });

  test("history 中旧记录、错误 nonce、半行 JSON 或缺 session_id 时保持未确认", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-history-")); directories.push(cwd);
    const history = join(cwd, "history.jsonl");
    await writeFile(history, "", "utf8");
    const adapter = new CodexInteractiveAdapter(new RecordingBackend(), { command: "codex", historyPath: history, historyPollMs: 1, pasteSettleMs: 1, confirmationAttemptMs: 10 });
    const request = { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: join(cwd, "session.json") } as const;
    const plan = await adapter.launch(request, new AbortController().signal);
    const prompt = (plan.submissionContext as { submittedPrompt: string }).submittedPrompt;
    const wrongNonce = prompt.replace(/wf-submit:[0-9a-f-]{36}/, "wf-submit:00000000-0000-4000-8000-000000000000");
    await writeFile(history, `${JSON.stringify({ text: prompt, session_id: "old-before-launch" })}\n`, "utf8");
    const nextPlan = await adapter.launch(request, new AbortController().signal);
    await adapter.submitInitialPrompt(request, nextPlan, identityFor("review"), new AbortController().signal);
    const nextPrompt = (nextPlan.submissionContext as { submittedPrompt: string }).submittedPrompt;
    await writeFile(history, `${JSON.stringify({ text: wrongNonce, session_id: "foreign" })}\n${JSON.stringify({ text: nextPrompt })}\n{"text":"partial`, { encoding: "utf8", flag: "a" });
    const controller = new AbortController();
    const confirmation = adapter.confirmInitialPrompt(request, nextPlan, identityFor("review"), controller.signal);
    const result = await Promise.race([
      confirmation,
      Bun.sleep(30).then(() => "timeout" as const),
    ]);
    expect(result).toBe("timeout");
    // race 的超时不会取消仍在轮询 history 的 Promise；必须显式终止并等待它收尾，
    // 否则测试进程会保留定时器，导致完整 bun test 永远不结束。
    controller.abort();
    await expect(confirmation).rejects.toThrow("Gate 已取消");
  });

  test("Bootstrap 只在 Codex 原生 history 追加匹配记录后返回 native-history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-bootstrap-")); directories.push(cwd);
    const history = join(cwd, "history.jsonl"); await writeFile(history, "", "utf8");
    const identity: SessionIdentity = { backend: "tmux", sessionName: "wf-test", backendRef: "/tmp/wf.sock", runId: "11111111-1111-4111-8111-111111111111", nodeId: "review", agentSessionId: "agent", cli: "codex", createdAt: "2026-01-01T00:00:00.000Z" };
    let destroyed = false;
    const backend: SessionBackend = {
      async create(options: CreateSessionOptions) {
        const prompt = options.command.at(-1);
        await writeFile(history, `${JSON.stringify({ text: prompt, session_id: "codex-native-session" })}\n`, { encoding: "utf8", flag: "a" });
        return identity;
      },
      async sendText() {}, async pasteText(_identity, text) { await writeFile(history, `${JSON.stringify({ text, session_id: "codex-native-session" })}\n`, { encoding: "utf8", flag: "a" }); }, async sendSpecialKey() {}, async readRecent() { return readyScreen(cwd); }, async liveness() { return "exists" as SessionLiveness; }, async detach() {},
      async destroy(): Promise<DestroyResult> { destroyed = true; return { status: "destroyed", diagnostic: null }; },
    };
    const request = { runId: identity.runId, node: node({ cwd, request: { ...node().request, cwd } }), prompt: "检查变更", identityFile: join(cwd, "session.json") } as const;
    const result = await new InteractiveCliBootstrap(backend, 100).start(new CodexInteractiveAdapter(backend, { command: "codex", historyPath: history, historyPollMs: 1, pasteSettleMs: 1, confirmationAttemptMs: 10 }), request);
    expect(result.submission).toEqual({ submitted: true, proof: "native-history", cliSessionId: "codex-native-session", diagnostic: "已确认 Codex 原生 history 提交记录。" });
    expect(destroyed).toBe(false);
  });

  test("没有可归属的 history 记录时 Bootstrap 超时并清理已创建会话", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-bootstrap-")); directories.push(cwd);
    const history = join(cwd, "history.jsonl"); await writeFile(history, "", "utf8");
    const identity: SessionIdentity = { backend: "tmux", sessionName: "wf-test", backendRef: "/tmp/wf.sock", runId: "11111111-1111-4111-8111-111111111111", nodeId: "review", agentSessionId: "agent", cli: "codex", createdAt: "2026-01-01T00:00:00.000Z" };
    let destroyed = false;
    const backend: SessionBackend = {
      async create() { return identity; }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return readyScreen(cwd); }, async liveness() { return "exists" as SessionLiveness; }, async detach() {},
      async destroy(): Promise<DestroyResult> { destroyed = true; return { status: "destroyed", diagnostic: null }; },
    };
    const request = { runId: identity.runId, node: node({ cwd, request: { ...node().request, cwd } }), prompt: "检查变更", identityFile: join(cwd, "session.json") } as const;
    await expect(new InteractiveCliBootstrap(backend, 30).start(new CodexInteractiveAdapter(backend, { command: "codex", historyPath: history, historyPollMs: 1, pasteSettleMs: 1, confirmationAttemptMs: 10 }), request)).rejects.toThrow("首条 Prompt confirm Gate 超时");
    expect(destroyed).toBe(true);
  });

  test("confirm Gate 被取消后停止 history 轮询", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-cancel-")); directories.push(cwd);
    const history = join(cwd, "history.jsonl"); await writeFile(history, "", "utf8");
    const adapter = new CodexInteractiveAdapter(new RecordingBackend(), { command: "codex", historyPath: history, historyPollMs: 50, pasteSettleMs: 1, confirmationAttemptMs: 10 });
    const request = { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: join(cwd, "session.json") } as const;
    const plan = await adapter.launch(request, new AbortController().signal);
    await adapter.submitInitialPrompt(request, plan, identityFor("review"), new AbortController().signal);
    const controller = new AbortController();
    const pending = adapter.confirmInitialPrompt(request, plan, {} as never, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Gate 已取消");
  });

  test("Ready Gate 拒绝 loading 与编号菜单，直到真实 composer 与 banner 同时出现", async () => {
    const backend = new RecordingBackend();
    backend.screen = "│ model: loading │\n› 1. Update now\ngpt · /workspace · Ready";
    const adapter = new CodexInteractiveAdapter(backend, { pasteSettleMs: 1, historyPollMs: 1 });
    const request = { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/session.json" } as const;
    const plan = await adapter.launch(request, new AbortController().signal);
    const controller = new AbortController();
    const pending = adapter.waitUntilReady(request, plan, identityFor("review"), controller.signal);
    await Bun.sleep(5);
    backend.screen = readyScreen();
    await expect(pending).resolves.toMatchObject({ ready: true });
  });

  test("接受 Codex 0.159 当前标题/cwd/页脚布局，但仍要求节点 cwd 精确匹配", async () => {
    const backend = new RecordingBackend();
    backend.screen = currentReadyScreen();
    const adapter = new CodexInteractiveAdapter(backend, { historyPollMs: 1 });
    const request = { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/session.json" } as const;
    const plan = await adapter.launch(request, new AbortController().signal);
    await expect(adapter.waitUntilReady(request, plan, identityFor("review"), new AbortController().signal)).resolves.toMatchObject({ ready: true });
    backend.screen = currentReadyScreen("/other-project");
    const controller = new AbortController();
    const pending = adapter.waitUntilReady(request, plan, identityFor("review"), controller.signal);
    await Bun.sleep(3);
    controller.abort();
    await expect(pending).rejects.toThrow("Gate 已取消");
  });

  test("history 未在首个窗口出现时按 Botmux 策略重试 Enter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-retry-")); directories.push(cwd);
    const history = join(cwd, "history.jsonl"); await writeFile(history, "", "utf8");
    const backend = new RecordingBackend();
    const adapter = new CodexInteractiveAdapter(backend, { historyPath: history, historyPollMs: 1, pasteSettleMs: 1, confirmationAttemptMs: 5 });
    const request = { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: join(cwd, "session.json") } as const;
    const plan = await adapter.launch(request, new AbortController().signal);
    await adapter.submitInitialPrompt(request, plan, identityFor("review"), new AbortController().signal);
    setTimeout(async () => {
      await writeFile(history, `${JSON.stringify({ text: backend.pasted[0], session_id: "retried-session" })}\n`, { encoding: "utf8", flag: "a" });
    }, 8);
    await expect(adapter.confirmInitialPrompt(request, plan, identityFor("review"), new AbortController().signal)).resolves.toMatchObject({ submitted: true, cliSessionId: "retried-session" });
    expect(backend.keys.length).toBeGreaterThanOrEqual(2);
    expect(backend.keys.length).toBeLessThanOrEqual(4);
  });
});
