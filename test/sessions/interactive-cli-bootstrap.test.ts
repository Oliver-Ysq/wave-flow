import { describe, expect, test } from "bun:test";
import { InteractiveCliBootstrap, InteractiveCliBootstrapError } from "../../src/sessions/bootstrap/interactive-cli-bootstrap";
import type { InteractiveCliAdapter, InteractiveCliLaunchPlan, InteractiveCliStartRequest, PromptReadyEvidence, PromptSubmissionEvidence } from "../../src/adapters/interactive-cli-adapter";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { CreateSessionOptions, DestroyResult, SessionBackend, SessionIdentity, SessionLiveness } from "../../src/sessions/types";

function node(): AgentNodeSnapshot {
  return { id: "node", phase: "phase", sequence: 1, cli: "codex", sandbox: "read-only", cwd: "/project", label: "Node", status: "running", result: null, diagnostic: null, createdAt: "2026-01-01T00:00:00.000Z", startedAt: null, endedAt: null, agentSessionId: null, block: null, request: { id: "node", cli: "codex", cwd: "/project", sandbox: "read-only", prompt: "任务", phase: "phase" } };
}

class RecordingBackend implements SessionBackend {
  readonly calls: string[] = [];
  identity: SessionIdentity = { backend: "tmux", sessionName: "wf-session", backendRef: "/tmp/wf.sock", runId: "11111111-1111-4111-8111-111111111111", nodeId: "node", agentSessionId: "agent", cli: "codex", createdAt: "2026-01-01T00:00:00.000Z" };
  async create(_options: CreateSessionOptions): Promise<SessionIdentity> { this.calls.push("create"); return this.identity; }
  async sendText(_identity: SessionIdentity, _text: string): Promise<void> {}
  async pasteText(_identity: SessionIdentity, _text: string): Promise<void> {}
  async sendSpecialKey(_identity: SessionIdentity, _key: "Enter"): Promise<void> {}
  async readRecent(_identity: SessionIdentity, _lines?: number): Promise<string> { return ""; }
  async liveness(_identity: SessionIdentity): Promise<SessionLiveness> { return "exists"; }
  async detach(_identity: SessionIdentity): Promise<void> {}
  async destroy(_identity: SessionIdentity): Promise<DestroyResult> { this.calls.push("destroy"); return { status: "destroyed", diagnostic: null }; }
}

class FakeAdapter implements InteractiveCliAdapter {
  readonly id = "fake";
  constructor(readonly cli: "codex" = "codex") {}
  readonly calls: string[] = [];
  ready: PromptReadyEvidence = { ready: true, diagnostic: "fake ready" };
  submission: PromptSubmissionEvidence = { submitted: true, proof: "native-hook", cliSessionId: "cli-session", diagnostic: "fake confirmed" };
  async launch(_request: InteractiveCliStartRequest, _signal: AbortSignal): Promise<InteractiveCliLaunchPlan> { this.calls.push("launch"); return { command: ["fake-cli"] }; }
  async waitUntilReady(_request: InteractiveCliStartRequest, _plan: InteractiveCliLaunchPlan, _identity: SessionIdentity, _signal: AbortSignal): Promise<PromptReadyEvidence> { this.calls.push("ready"); return this.ready; }
  async submitInitialPrompt(_request: InteractiveCliStartRequest, _plan: InteractiveCliLaunchPlan, _identity: SessionIdentity, _signal: AbortSignal): Promise<void> { this.calls.push("submit"); }
  async confirmInitialPrompt(_request: InteractiveCliStartRequest, _plan: InteractiveCliLaunchPlan, _identity: SessionIdentity, _signal: AbortSignal): Promise<PromptSubmissionEvidence> { this.calls.push("confirm"); return this.submission; }
}

function request(): InteractiveCliStartRequest { return { runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "任务", identityFile: "/project/session.json" }; }

describe("InteractiveCliBootstrap", () => {
  test("按 launch、create、ready、submit、confirm 顺序只接受 Adapter 的标准化证据", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter();
    const result = await new InteractiveCliBootstrap(backend).start(adapter, request());
    expect(adapter.calls).toEqual(["launch", "ready", "submit", "confirm"]);
    expect(backend.calls).toEqual(["create"]);
    expect(result.submission).toEqual(adapter.submission);
  });

  test("ready 未通过时不提交 Prompt，销毁已创建会话并 fail closed", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter(); adapter.ready = { ready: false, diagnostic: "loading" };
    await expect(new InteractiveCliBootstrap(backend).start(adapter, request())).rejects.toThrow("首条 Prompt 尚未就绪：loading");
    expect(adapter.calls).toEqual(["launch", "ready"]);
    expect(backend.calls).toEqual(["create", "destroy"]);
  });

  test("未确认提交时不将 launch 或 submit 冒充为成功，并保留销毁结果", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter(); adapter.submission = { submitted: false, proof: "unconfirmed", diagnostic: "no native proof" };
    await expect(new InteractiveCliBootstrap(backend).start(adapter, request())).rejects.toMatchObject({ destroy: { status: "destroyed", diagnostic: null } } satisfies Partial<InteractiveCliBootstrapError>);
    expect(adapter.calls).toEqual(["launch", "ready", "submit", "confirm"]);
    expect(backend.calls).toEqual(["create", "destroy"]);
  });

  test("拒绝将一个 CLI 的 Adapter 用于另一个 CLI 节点，且不创建会话", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter("traex" as never);
    await expect(new InteractiveCliBootstrap(backend).start(adapter, request())).rejects.toThrow("不能启动 cli: codex 节点");
    expect(adapter.calls).toEqual([]);
    expect(backend.calls).toEqual([]);
  });

  test("拒绝 submitted 与 unconfirmed 自相矛盾的 Adapter 证据", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter(); adapter.submission = { submitted: true, proof: "unconfirmed", diagnostic: "invalid" };
    await expect(new InteractiveCliBootstrap(backend).start(adapter, request())).rejects.toThrow("首条 Prompt 未获确认：invalid");
    expect(backend.calls).toEqual(["create", "destroy"]);
  });

  test("拒绝缺少 CLI 原生会话身份的确认，避免误认同机其他会话证据", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter(); adapter.submission = { submitted: true, proof: "native-history", diagnostic: "unbound" };
    await expect(new InteractiveCliBootstrap(backend).start(adapter, request())).rejects.toThrow("确认缺少可关联的 CLI 原生会话身份");
    expect(backend.calls).toEqual(["create", "destroy"]);
  });

  test("SessionBackend 返回错误身份时不调用 Adapter Gate，并销毁该会话", async () => {
    const backend = new RecordingBackend(); backend.identity = { ...backend.identity, nodeId: "other-node" };
    const adapter = new FakeAdapter();
    await expect(new InteractiveCliBootstrap(backend).start(adapter, request())).rejects.toThrow("会话身份与请求的 Run、节点或 CLI 不匹配");
    expect(adapter.calls).toEqual(["launch"]);
    expect(backend.calls).toEqual(["create", "destroy"]);
  });

  test("Gate 超时时清理会话，而不是无限等待", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter();
    adapter.waitUntilReady = async () => new Promise<PromptReadyEvidence>(() => undefined);
    await expect(new InteractiveCliBootstrap(backend, 1).start(adapter, request())).rejects.toThrow("首条 Prompt ready Gate 超时");
    expect(adapter.calls).toEqual(["launch"]);
    expect(backend.calls).toEqual(["create", "destroy"]);
  });

  test("Gate 超时会向 Adapter 发送 abort，避免遗留后台观察", async () => {
    const backend = new RecordingBackend(); const adapter = new FakeAdapter();
    let aborted = false;
    adapter.waitUntilReady = async (_request, _plan, _identity, signal) => new Promise<PromptReadyEvidence>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("observing cancelled")); }, { once: true });
    });
    await expect(new InteractiveCliBootstrap(backend, 1).start(adapter, request())).rejects.toThrow("首条 Prompt ready Gate 超时");
    expect(aborted).toBe(true);
    expect(backend.calls).toEqual(["create", "destroy"]);
  });
});
