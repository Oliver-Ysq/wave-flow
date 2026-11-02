import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer } from "../../src/control/control-server";
import { RunJournal } from "../../src/journal/run-journal";
import { runsRoot } from "../../src/journal/paths";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { AcpWorkerExecutor, type AcpWorkerSession } from "../../src/runtime/acp-worker-executor";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { AcpSessionBinding } from "../../src/adapters/acp-session";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-inplace-")); directories.push(cwd);
  const manifest: RunManifest = {
    runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION,
    workflow: { name: "inplace", description: "原地续用。", phases: [{ title: "run" }] },
    workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd,
    input: {}, createdAt: new Date().toISOString(),
  };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  const at = (): string => new Date().toISOString();
  state.apply({ type: "run.created", at: at(), runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, cwd, sandbox: "read-only" as const, prompt: "做事", phase: "run" };
  const created: JournalEvent = { type: "agent.created", at: at(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const agentSessionId = "wf-session-1";
  const running: JournalEvent = { type: "agent.status", at: at(), runId: manifest.runId, nodeId: "node", agentSessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  const control = new ControlServer(journal, state);
  return { journal, state, control, runId: manifest.runId, agentSessionId };
}

class FakeSession implements AcpWorkerSession {
  binding: AcpSessionBinding | null = null;
  readonly prompts: string[] = [];
  constructor(
    private readonly mode: "die" | "complete",
    private readonly complete: () => Promise<void>,
    private readonly failLoad = false,
  ) {}
  async initialize(): Promise<unknown> { return {}; }
  async createSession(): Promise<AcpSessionBinding> {
    this.binding = { launcherId: "codex-acp", sessionId: "acp-1", capabilities: {}, writer: { pgid: 4242, startedAt: "fp-1" } };
    return this.binding;
  }
  async loadSession(sessionId: string): Promise<AcpSessionBinding> {
    if (this.failLoad) throw new Error("session/load 失败。");
    this.binding = { launcherId: "codex-acp", sessionId, capabilities: {}, writer: { pgid: 5252, startedAt: "fp-2" } };
    return this.binding;
  }
  async prompt(text: string): Promise<{ readonly stopReason: string }> {
    this.prompts.push(text);
    if (this.mode === "die") throw new Error("ACP Agent 进程已退出（137）。");
    await this.complete();
    return { stopReason: "end_turn" };
  }
  async cancel(): Promise<void> {}
  close(): void {}
  verifyClosed(): Promise<void> { return Promise.resolve(); }
  subscribe(): () => void { return () => {}; }
}

test("续用失败进入节点级暂停，用户恢复后重建并完成", async () => {
  const value = await fixture();
  const sessions: FakeSession[] = [];
  let capability = "";
  let identity: { runId: string; nodeId: string; agentSessionId: string } | null = null;
  const createControlMcp = (input: { runId: string; nodeId: string; agentSessionId: string; capability: string }) => {
    capability = input.capability;
    identity = { runId: input.runId, nodeId: input.nodeId, agentSessionId: input.agentSessionId };
    return { name: "fake-control", command: "/bin/true", args: [], env: [] } as never;
  };
  const executeComplete = async (): Promise<void> => {
    await value.control.complete({ ...identity!, capability, summary: "done", result: { ok: true } });
  };
  const createSession = () => {
    const index = sessions.length;
    // 0 首次启动后进程退出；1 续用 load 失败；2 用户 recover 后重建成功。
    const session = new FakeSession(index === 0 ? "die" : "complete", executeComplete, index === 1);
    sessions.push(session);
    return session;
  };
  const executor = new AcpWorkerExecutor({ id: "fake", command: "fake", args: [] }, createSession, undefined, createControlMcp);
  executor.bindControl(value.control);
  const node = value.state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;
  executor.bindRecoveryHold(async () => {
    await executor.pause(node);
    // 模拟用户在节点暂停后点击同会话重试；不能在 hold 回调里 await 完成，否则会与 runTurn 互相等待。
    void executor.recover(node).catch(() => undefined);
  });

  const result = await executor.execute(node);
  expect(result).toEqual({ ok: true });
  expect(sessions).toHaveLength(3);
  expect(sessions[2]!.prompts[0]).toContain("上一回合被中断");
  expect(value.state.agent("node").status).toBe("completed");
}, 30_000);

test("restart 携带 continuedFrom 时直接 load 原会话，不走 session/new", async () => {
  const value = await fixture();
  const sessions: FakeSession[] = [];
  let capability = "";
  let identity: { runId: string; nodeId: string; agentSessionId: string } | null = null;
  const createControlMcp = (input: { runId: string; nodeId: string; agentSessionId: string; capability: string }) => {
    capability = input.capability;
    identity = { runId: input.runId, nodeId: input.nodeId, agentSessionId: input.agentSessionId };
    return { name: "fake-control", command: "/bin/true", args: [], env: [] } as never;
  };
  const executeComplete = async (): Promise<void> => {
    await value.control.complete({ ...identity!, capability, summary: "done", result: { ok: true } });
  };
  const createSession = () => {
    const session = new FakeSession("complete", executeComplete);
    sessions.push(session);
    return session;
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, createSession, undefined, createControlMcp);
  executor.bindControl(value.control);
  const base = value.state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;
  const node = { ...base, continuation: { launcherId: "codex-acp", sessionId: "acp-1" } };

  const result = await executor.execute(node);
  expect(result).toEqual({ ok: true });
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.prompts[0]).toContain("上一回合被中断");
}, 30_000);

test("写 Worker 同样在同一 attempt 内围栏旧 writer、load 原会话并耐久新 writer 证据", async () => {
  const value = await fixture();
  const sessions: FakeSession[] = [];
  let capability = "";
  let identity: { runId: string; nodeId: string; agentSessionId: string } | null = null;
  const createControlMcp = (input: { runId: string; nodeId: string; agentSessionId: string; capability: string }) => {
    capability = input.capability;
    identity = { runId: input.runId, nodeId: input.nodeId, agentSessionId: input.agentSessionId };
    return { name: "fake-control", command: "/bin/true", args: [], env: [] } as never;
  };
  const executeComplete = async (): Promise<void> => {
    await value.control.complete({ ...identity!, capability, summary: "done", result: { ok: true } });
  };
  const createSession = () => {
    const session = new FakeSession(sessions.length === 0 ? "die" : "complete", executeComplete);
    if (sessions.length === 1) {
      // 第二个 provider 在 initialize（真正 spawn）时，启动意图必须已经耐久。
      session.initialize = async () => {
        expect(value.state.agent("node").writerIntentAt).not.toBeNull();
        return {};
      };
    }
    sessions.push(session);
    return session;
  };
  const executor = new AcpWorkerExecutor({ id: "fake", command: "fake", args: [] }, createSession, undefined, createControlMcp, undefined, true);
  executor.bindControl(value.control);
  const node = value.state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;

  const result = await executor.execute(node);
  expect(result).toEqual({ ok: true });
  expect(sessions).toHaveLength(2);
  expect(sessions[1]!.binding?.sessionId).toBe("acp-1");
  expect(sessions[1]!.prompts[0]).toContain("上一回合被中断");
  // 续用后的进程证据在 load 成功、capability 切换前耐久写入，并清除启动意图。
  expect(value.state.agent("node").writer).toEqual({ pgid: 5252, startedAt: "fp-2" });
  expect(value.state.agent("node").writerIntentAt).toBeNull();
  await expect(executor.finalizeCompleted({ ...node, status: "completed", result: { ok: true } })).resolves.toBeUndefined();
}, 30_000);

test("provider 退出后同一 attempt 内围栏、load 并续用原会话", async () => {
  const value = await fixture();
  const sessions: FakeSession[] = [];
  let capability = "";
  let identity: { runId: string; nodeId: string; agentSessionId: string } | null = null;
  const createControlMcp = (input: { runId: string; nodeId: string; agentSessionId: string; capability: string }) => {
    capability = input.capability;
    identity = { runId: input.runId, nodeId: input.nodeId, agentSessionId: input.agentSessionId };
    return { name: "fake-control", command: "/bin/true", args: [], env: [] } as never;
  };
  const executeComplete = async (): Promise<void> => {
    await value.control.complete({ ...identity!, capability, summary: "done", result: { ok: true } });
  };
  const createSession = () => {
    const session = new FakeSession(sessions.length === 0 ? "die" : "complete", executeComplete);
    sessions.push(session);
    return session;
  };
  const executor = new AcpWorkerExecutor({ id: "fake", command: "fake", args: [] }, createSession, undefined, createControlMcp);
  executor.bindControl(value.control);
  const node = value.state.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.id === "node")!;

  const result = await executor.execute(node);
  expect(result).toEqual({ ok: true });
  expect(sessions).toHaveLength(2);
  expect(sessions[1]!.binding?.sessionId).toBe("acp-1");
  expect(sessions[1]!.prompts[0]).toContain("上一回合被中断");
  expect(value.state.agent("node").writer).toEqual({ pgid: 5252, startedAt: "fp-2" });
}, 30_000);
