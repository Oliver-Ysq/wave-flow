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

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-acp-executor-")); directories.push(cwd);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "acp", description: "ACP.", phases: [{ title: "run" }] }, workflowHash: "c".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, cwd, sandbox: "workspace-write" as const, prompt: "complete with JSON", phase: "run" };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const agentSessionId = "acp-agent";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  return { cwd, manifest, journal, state, control: new ControlServer(journal, state), node: state.agent("node"), agentSessionId };
}

test("ACP Worker 先耐久 binding，只有 Control complete 才返回结果", async () => {
  const value = await fixture();
  let prompt = "";
  let launcherCapability: string | undefined;
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-acp", capabilities: { loadSession: true } }; },
    async prompt(text) { prompt = text; await value.control.completeReclaimed({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.agentSessionId, summary: "done", result: { ok: true } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [], env: { WAVE_FLOW_CONTROL_COMMAND: "'/managed/wave-flow'" } }, (launcher) => { launcherCapability = launcher.env?.WF_CONTROL_CAPABILITY; return session; });
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(prompt).toContain(`--run-id ${value.manifest.runId} --node-id node --agent-session-id ${value.agentSessionId}`);
  expect(launcherCapability).toMatch(/^[0-9a-f-]{36}$/);
  const reopened = await RunJournal.open(value.manifest.runId, runsRoot(value.cwd));
  const binding = reopened.events.find((event) => event.type === "agent.session");
  expect(binding).toMatchObject({ delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "native-acp" } });
});

test("Control complete 不等待 ACP prompt 自然收尾", async () => {
  const value = await fixture();
  let releasePrompt!: (value: { readonly stopReason: string }) => void;
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-acp", capabilities: {} }; },
    async prompt() {
      await value.control.completeReclaimed({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.agentSessionId, summary: "done", result: { ok: true } });
      return new Promise((resolve) => { releasePrompt = resolve; });
    },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [], env: { WAVE_FLOW_CONTROL_COMMAND: "'/managed/wave-flow'" } }, () => session);
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  releasePrompt({ stopReason: "end_turn" });
});

test("ACP turn 结束但未 complete 时必须中断，不能伪造节点完成", async () => {
  const value = await fixture();
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-acp", capabilities: {} }; },
    async prompt() { return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session);
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).rejects.toThrow("未收到 wave-flow complete");
  expect(value.state.agent("node").status).toBe("running");
});

test("ACP pause 必须等待 cancelled，recover 在同一 session 发现场检查回合", async () => {
  const value = await fixture();
  let resolveFirst!: (value: { readonly stopReason: string }) => void;
  const prompts: string[] = [];
  const session: AcpWorkerSession = {
    get binding() { return { launcherId: "codex-acp", sessionId: "native-acp", capabilities: {} }; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-acp", capabilities: {} }; },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      await value.control.completeReclaimed({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.agentSessionId, summary: "recovered", result: { ok: true } });
      return { stopReason: "end_turn" };
    },
    async cancel() { resolveFirst({ stopReason: "cancelled" }); }, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [], env: { WAVE_FLOW_CONTROL_COMMAND: "'/managed/wave-flow'" } }, () => session);
  executor.bindControl(value.control);
  const running = executor.execute(value.node);
  await waitFor(() => prompts.length === 1);
  await executor.pause(value.node);
  expect(prompts).toHaveLength(1);
  await executor.recover(value.node);
  await expect(running).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("检查当前工作目录");
  expect(prompts[1]).not.toContain("complete with JSON");
  expect(prompts[1]).toContain("'/managed/wave-flow' complete");
});

test("ACP Worker 在首个 turn 未建立时拒绝伪造 pause", async () => {
  const value = await fixture();
  let releaseInitialize!: () => void;
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() { await new Promise<void>((resolve) => { releaseInitialize = resolve; }); },
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-acp", capabilities: {} }; },
    async prompt() { return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session);
  executor.bindControl(value.control);
  const running = executor.execute(value.node);
  await expect(executor.pause(value.node)).rejects.toThrow("尚未建立可取消");
  releaseInitialize();
  await expect(running).rejects.toThrow("未收到 wave-flow complete");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("测试等待超时。 ");
}
