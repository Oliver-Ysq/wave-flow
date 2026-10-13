import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer } from "../../src/control/control-server";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { AcpWorkerExecutor, type AcpWorkerSession } from "../../src/runtime/acp-worker-executor";
import type * as acp from "@agentclientprotocol/sdk";
import { RunStateMachine } from "../../src/runtime/run-state-machine";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-acp-only-")); directories.push(cwd);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "acp", description: "ACP.", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, sandbox: "workspace-write" as const, cwd, prompt: "complete", phase: "run" };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const sessionId = "worker-session";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: sessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  return { cwd, manifest, journal, state, control: new ControlServer(journal, state), node: state.agent("node"), sessionId };
}

test("ACP Worker 只在 durable binding 与 capability complete 后完成", async () => {
  const value = await fixture();
  let capability = "";
  let managed = "";
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) { managed = text; await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: { ok: true } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, (launcher) => { capability = launcher.env?.WF_CONTROL_CAPABILITY ?? ""; return session; });
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(managed).toContain("高优先级、不可省略");
  expect(managed).toContain("即使业务任务要求“只回复”“只输出 JSON”");
  expect(managed).toContain("wave_flow_complete");
  const opened = await RunJournal.open(value.manifest.runId, runsRoot(value.cwd));
  expect(opened.events).toContainEqual(expect.objectContaining({ type: "agent.session", delivery: "acp", acp: expect.objectContaining({ sessionId: "native-session" }) }));
});

test("ACP Worker cancel 确认后仅在同一 session recover", async () => {
  const value = await fixture();
  let capability = "";
  let releaseFirst!: (result: { readonly stopReason: string }) => void;
  const prompts: string[] = [];
  const session: AcpWorkerSession = {
    get binding() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "recovered", result: { ok: true } });
      return { stopReason: "end_turn" };
    },
    async cancel() { releaseFirst({ stopReason: "cancelled" }); }, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, (launcher) => { capability = launcher.env?.WF_CONTROL_CAPABILITY ?? ""; return session; });
  executor.bindControl(value.control);
  const running = executor.execute(value.node);
  while (prompts.length === 0) await Bun.sleep(1);
  await executor.pause(value.node);
  await executor.recover(value.node);
  await expect(running).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("检查当前工作目录");
});

test("首个 end_turn 遗漏 complete 时仅补发同 session 的完成提醒", async () => {
  const value = await fixture(); let capability = ""; const prompts: string[] = [];
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) { prompts.push(text); if (prompts.length === 1) return { stopReason: "end_turn" }; await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "recovered-report", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, launcher => { capability = launcher.env?.WF_CONTROL_CAPABILITY ?? ""; return session; }); executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2); expect(prompts[1]).toContain("不要重做业务任务");
});

test("真实 Worker session 仅注入节点私有的 Control MCP", async () => {
  const value = await fixture(); let capability = ""; let servers: readonly acp.McpServer[] = [];
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession(_cwd, _signal, mcpServers = []) { servers = mcpServers; return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt() { await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "mcp", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor(
    { id: "codex-acp", command: "fake", args: [] },
    launcher => { capability = launcher.env?.WF_CONTROL_CAPABILITY ?? ""; return session; },
    undefined,
    identity => ({ name: "wave-flow-worker-control", command: "/wave-flow-daemon", args: ["__worker-mcp"], env: [{ name: "WF_WORKER_MCP_CAPABILITY", value: identity.capability }] }),
  );
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(servers).toEqual([expect.objectContaining({ name: "wave-flow-worker-control", args: ["__worker-mcp"] })]);
});
