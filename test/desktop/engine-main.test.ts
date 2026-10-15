import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { verifyExecutable } from "../../src/runtimes/identity";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import type { HarnessSession } from "../../src/harness/session";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => { for (const child of children.splice(0)) child.kill(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** 私有 Engine 进程必须无需 HTTP/端口完成 ready、状态与受控退出。 */
test("Desktop Engine 通过 stdin/stdout JSONL 提供状态并在 shutdown 后退出", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-")); roots.push(root);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<unknown> => {
    while (true) {
      const index = buffered.indexOf("\n");
      if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); }
      const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true });
    }
  };
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "status", method: "engine.status" })}\n`));
  expect(await next()).toMatchObject({ requestId: "status", ok: true, result: { activeRuns: 0, activeHarnesses: 0 } });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "actions-status", method: "engine.action", action: "status", args: {} })}\n`));
  expect(await next()).toMatchObject({ requestId: "actions-status", ok: true, result: { activeRuns: 0, activeHarnesses: 0 } });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "legacy", method: `engine.${"http"}` })}\n`));
  expect(await next()).toMatchObject({ requestId: "legacy", ok: false, error: "Engine 请求方法无效。 " });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "close", method: "engine.shutdown" })}\n`));
  expect(await next()).toEqual({ requestId: "close", ok: true, result: { accepted: true } });
  expect(await child.exited).toBe(0);
});

/** 实际 Harness 快照可能远大于 pipe 单个读取块；Engine 必须逐行输出完整 JSON。 */
test("Desktop Engine 对大 Harness 列表响应保持完整 JSONL 帧", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-large-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-large-project-")); roots.push(cwd);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const next = async (): Promise<unknown> => { while (true) { const index = buffer.indexOf("\n"); if (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); return JSON.parse(line); } const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffer += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  // 构造远超单个 pipe 读取块（通常 64KB）的真实大响应：项目 + 多条接近上限的大消息。
  send({ requestId: "project", method: "engine.action", action: "projects.create", args: { cwd } });
  const project = await next() as { result: { project: { projectId: string } } };
  const projectId = project.result.project.projectId;
  send({ requestId: "start", method: "engine.action", action: "harnesses.startConversation", args: { projectId, text: "大帧测试".repeat(4_500) } });
  expect(await next()).toMatchObject({ ok: true });
  send({ requestId: "list-0", method: "engine.action", action: "harnesses.list", args: {} });
  const created = await next() as { result: { harnesses: { harnessRunId: string }[] } };
  const harnessRunId = created.result.harnesses[0].harnessRunId;
  const waitIdle = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      send({ requestId: `idle-${attempt}`, method: "engine.action", action: "harnesses.get", args: { harnessRunId } });
      // 事件帧与响应共用通道：等待响应时必须跳过无 requestId 的事件帧。
      let current = await next() as { type?: string; result?: { harness: { status: string } } };
      while (current.type === "event") current = await next() as typeof current;
      if (current.result!.harness.status !== "running") return;
      await Bun.sleep(10);
    }
    throw new Error("Harness 回合未在时限内结束。 ");
  };
  await waitIdle();
  for (let index = 0; index < 5; index += 1) {
    send({ requestId: `message-${index}`, method: "engine.action", action: "harnesses.send", args: { harnessRunId, text: "后续消息".repeat(4_500) } });
    expect(await next()).toMatchObject({ ok: true });
    await waitIdle();
  }
  send({ requestId: "harnesses", method: "engine.action", action: "harnesses.list", args: {} });
  const response = await next() as { requestId: string; ok: boolean; result: { harnesses: unknown[] } };
  expect(response.requestId).toBe("harnesses");
  expect(response.ok).toBe(true);
  // 响应体必须真实大于一个读取块，且 JSON 解析后的消息完整无截断。
  expect(JSON.stringify(response).length).toBeGreaterThan(64 * 1024);
  expect(Array.isArray(response.result.harnesses)).toBe(true);
  expect((response.result.harnesses as { messages: unknown[] }[])[0].messages.length).toBeGreaterThanOrEqual(12);
  send({ requestId: "close", method: "engine.shutdown" });
  await next(); expect(await child.exited).toBe(0);
});

/** 新 Engine 的 ready 只能在遗留 ACP 会话被耐久收敛后发出，避免短暂假活跃。 */
test("Desktop Engine 启动时将上次未结束的 ACP Worker 收敛为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-reconcile-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-project-")); roots.push(cwd);
  const runId = crypto.randomUUID();
  const manifest: RunManifest = { runId, clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "reconcile", description: "reconcile", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  await writeFile(manifest.workflowPath, "export default async function run() {}\n");
  const journal = await RunJournal.create(manifest, runsRoot(root));
  const events: JournalEvent[] = [
    { type: "execution-attempt.started", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 },
    { type: "phase.entered", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: null, title: "run", phaseVisitId: 1, occurrence: 1, executionAttemptId: 1 },
    { type: "agent.created", at: new Date().toISOString(), runId, nodeId: "worker", agentSessionId: null, diagnostic: null, sequence: 1, logicalSequence: 1, phase: "run", phaseVisitId: 1, executionAttemptId: 1, executionBatch: { sequence: 1, mode: "serial" }, request: { id: "worker", cli: "codex", sandbox: "workspace-write", cwd, prompt: "work", phase: "run" } },
    { type: "agent.status", at: new Date().toISOString(), runId, nodeId: "worker", agentSessionId: "old-session", diagnostic: null, status: "running" },
    { type: "agent.session", at: new Date().toISOString(), runId, nodeId: "worker", agentSessionId: "old-session", diagnostic: null, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "native-old", capabilities: {} } },
  ];
  for (const event of events) await journal.append(event);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const first = await reader.read();
  expect(JSON.parse(new TextDecoder().decode(first.value).trim())).toEqual({ type: "ready", protocolVersion: 1 });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "status", method: "engine.status" })}\n`));
  const response = await reader.read();
  expect(JSON.parse(new TextDecoder().decode(response.value).trim())).toMatchObject({ requestId: "status", ok: true, result: { acpWorkersNeedingResume: 1 } });
  const reopened = await RunJournal.open(runId, runsRoot(root));
  expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.status", nodeId: "worker", status: "interrupted" }));
  expect(reopened.events).toContainEqual(expect.objectContaining({ type: "run.status", status: "interrupted" }));
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "close", method: "engine.shutdown" })}\n`));
  await reader.read(); await child.exited;
});

/** 暂停控制在进程崩溃时同样不能留下 paused 节点与 interrupted Run 的矛盾投影。 */
test("Desktop Engine 启动时收敛 paused 节点，再将 Run 标为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-paused-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-paused-project-")); roots.push(cwd);
  const runId = crypto.randomUUID();
  const manifest: RunManifest = { runId, clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "paused", description: "paused", phases: [{ title: "run" }] }, workflowHash: "b".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  await writeFile(manifest.workflowPath, "export default async function run() {}\n");
  const journal = await RunJournal.create(manifest, runsRoot(root));
  const at = new Date().toISOString();
  const events: JournalEvent[] = [
    { type: "execution-attempt.started", at, runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 },
    { type: "phase.entered", at, runId, nodeId: null, agentSessionId: null, diagnostic: null, title: "run", phaseVisitId: 1, occurrence: 1, executionAttemptId: 1 },
    { type: "agent.created", at, runId, nodeId: "paused-worker", agentSessionId: null, diagnostic: null, sequence: 1, logicalSequence: 1, phase: "run", phaseVisitId: 1, executionAttemptId: 1, executionBatch: { sequence: 1, mode: "serial" }, request: { id: "paused-worker", cli: "codex", sandbox: "workspace-write", cwd, prompt: "work", phase: "run" } },
    { type: "agent.status", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: null, status: "running" },
    { type: "agent.session", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: null, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "native-old-paused", capabilities: {} } },
    { type: "run.status", at, runId, nodeId: null, agentSessionId: null, diagnostic: "pause", status: "pausing" },
    { type: "agent.status", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: "pause", status: "pausing" },
    { type: "agent.status", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: "paused", status: "paused" },
    { type: "run.status", at, runId, nodeId: null, agentSessionId: null, diagnostic: "paused", status: "paused" },
  ];
  for (const event of events) await journal.append(event);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); await reader.read();
  const reopened = await RunJournal.open(runId, runsRoot(root));
  const statusEvents = reopened.events.filter((event): event is Extract<JournalEvent, { type: "agent.status" }> => event.type === "agent.status" && event.nodeId === "paused-worker");
  expect(statusEvents.at(-1)?.status).toBe("interrupted");
  expect(reopened.events.filter((event): event is Extract<JournalEvent, { type: "run.status" }> => event.type === "run.status").at(-1)?.status).toBe("interrupted");
  child.kill(); await child.exited;
});

/** 事件帧与请求响应共用同一 JSONL 通道：事件帧带协议版本/会话 ID/单调序号，响应关联不受影响。 */
test("Desktop Engine 事件帧携带协议版本与单调序号，与请求响应同通道分流", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-events-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-events-project-")); roots.push(cwd);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const index = buffered.indexOf("\n");
      if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line) as Record<string, unknown>; }
      const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true });
    }
  };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  send({ requestId: "project", method: "engine.action", action: "projects.create", args: { cwd } });
  const project = await next() as { result: { project: { projectId: string } } };
  const frames: { seq: number; event: { type: string }; harnessRunId: string }[] = [];
  let harnessRunId = "";
  // 等待响应的同时收集事件帧：中文正文跨 pipe 读取块时帧也必须完整可解析。
  send({ requestId: "start", method: "engine.action", action: "harnesses.startConversation", args: { projectId: project.result.project.projectId, text: "观察事件帧".repeat(2_000) } });
  let sawTurnFinished = false;
  for (let attempt = 0; attempt < 400 && !sawTurnFinished; attempt += 1) {
    const frame = await next();
    if (frame.type === "event") {
      expect(frame.protocolVersion).toBe(1);
      expect(frame.stream).toBe("harness");
      const eventFrame = frame as unknown as { harnessRunId: string; seq: number; event: { type: string } };
      if (harnessRunId) expect(eventFrame.harnessRunId).toBe(harnessRunId);
      harnessRunId = eventFrame.harnessRunId;
      frames.push(eventFrame);
      if (eventFrame.event.type === "turn_finished") sawTurnFinished = true;
    }
  }
  expect(sawTurnFinished).toBe(true);
  // 序号从 1 开始严格递增；帧内只允许耐久派生事件，瞬时 delta 不上帧。
  expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
  expect(frames.some((frame) => frame.event.type === "entry_started")).toBe(true);
  expect(frames.some((frame) => frame.event.type === "entry_finished")).toBe(true);
  expect(frames.every((frame) => !["reasoning_delta", "assistant_delta", "acp_tool_call", "acp_tool_update"].includes(frame.event.type))).toBe(true);
  // 事件流之后请求响应通道仍然正常工作。
  send({ requestId: "after", method: "engine.action", action: "harnesses.list", args: {} });
  const listed = await next() as { requestId: string; ok: boolean };
  expect(listed).toMatchObject({ requestId: "after", ok: true });
  send({ requestId: "close", method: "engine.shutdown" });
  await next(); expect(await child.exited).toBe(0);
});

/** Runtime action 契约：已移除的 setWorkerEnabled 一律拒绝，validate 必须显式携带 cli。 */test("Engine runtime action 校验 validate 请求并拒绝已移除的 setWorkerEnabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-runtimes-")); roots.push(root);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<{ ok?: boolean; error?: string; type?: string; protocolVersion?: number }> => {
    while (true) {
      const index = buffered.indexOf("\n");
      if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); }
      const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true });
    }
  };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  // Worker 启用池已移除：旧 action 不再注册，一律按未知 action 拒绝
  send({ requestId: "toggle-removed", method: "engine.action", action: "runtimes.setWorkerEnabled", args: { runtimeId: crypto.randomUUID(), enabled: true } });
  expect((await next()).error).toContain("未知 Desktop action");
  send({ requestId: "validate-no-cli", method: "engine.action", action: "runtimes.validate", args: { executablePath: "/bin/sh" } });
  expect((await next()).error).toContain("验证请求无效");
  send({ requestId: "validate-bad-cli", method: "engine.action", action: "runtimes.validate", args: { executablePath: "/bin/sh", cli: "traex" } });
  expect((await next()).error).toContain("验证请求无效");
  send({ requestId: "close", method: "engine.shutdown" });
  await next(); expect(await child.exited).toBe(0);
});

/** 崩溃可发生在首个 Agent session 建立前；没有节点也不能把丢失调用栈伪装成 running。 */
test("Desktop Engine 启动时将无 Agent 的 live Run 收敛为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-empty-live-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-empty-live-project-")); roots.push(cwd);
  const runId = crypto.randomUUID();
  const manifest: RunManifest = { runId, clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "empty-live", description: "empty-live", phases: [{ title: "run" }] }, workflowHash: "c".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  await writeFile(manifest.workflowPath, "export default async function run() {}\n");
  const journal = await RunJournal.create(manifest, runsRoot(root));
  await journal.append({ type: "execution-attempt.started", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 });
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); await reader.read();
  const reopened = await RunJournal.open(runId, runsRoot(root));
  expect(reopened.events.filter((event): event is Extract<JournalEvent, { type: "run.status" }> => event.type === "run.status").at(-1)?.status).toBe("interrupted");
  child.kill(); await child.exited;
});

/** 主控切换的空闲语义在 Engine 层：运行中回合拒绝（409），空闲后允许并耐久 harnessRuntimeId。 */
test("Engine 有运行中主控回合时拒绝切换主控，空闲后允许", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-harness-switch-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-switch-project-")); roots.push(cwd);
  const registry = new CliRuntimeRegistry(root);
  const runtimeRecord = async (name: string, cli: "codex" | "kimi", harnessTools: boolean): Promise<CliRuntimeRecord> => {
    const executablePath = join(root, name); await writeFile(executablePath, "#!/bin/sh\necho cli\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
    const executable = await verifyExecutable(executablePath);
    return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: `${cli} 1.0`, discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: cli === "kimi" ? "kimi-acp" : "codex-acp", adapterVersion: "1.0", acpProtocolVersion: 1, harnessTools }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
  };
  const first = await registry.saveVerified(await runtimeRecord("codex-a", "codex", true));
  const second = await registry.saveVerified(await runtimeRecord("kimi-b", "kimi", true));
  const workerOnly = await registry.saveVerified(await runtimeRecord("kimi-c", "kimi", false));
  let release: (() => void) | null = null;
  const session: HarnessSession = {
    isRunning: true,
    subscribe: () => () => {},
    abort: () => {},
    prompt: () => new Promise<string>((resolve) => { release = () => resolve("回合完成"); }),
  };
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), createHarnessSession: async () => session });
  try {
    await engine.handleDesktopAction("runtimes.select", { runtimeId: first.runtimeId });
    // 无 harnessTools 的 runtime 即使空闲也不能设为主控。
    await expect(engine.handleDesktopAction("runtimes.select", { runtimeId: workerOnly.runtimeId })).rejects.toMatchObject({ status: 400 });
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, text: "进行中的回合" });
    await expect(engine.handleDesktopAction("runtimes.select", { runtimeId: second.runtimeId })).rejects.toMatchObject({ status: 409 });
    release!();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const listed = await engine.handleDesktopAction("harnesses.list", {}) as { harnesses: { status: string }[] };
      if (listed.harnesses.every((harness) => harness.status !== "running")) break;
      await Bun.sleep(10);
    }
    await engine.handleDesktopAction("runtimes.select", { runtimeId: second.runtimeId });
    const listed = await engine.handleDesktopAction("runtimes.list", {}) as { harnessRuntimeId: string | null };
    expect(listed.harnessRuntimeId).toBe(second.runtimeId);
  } finally { engine.shutdown(); }
});

/** validate action 统一走 Catalog 驱动的单验证器，测试缝签名为 (cli, input)。 */
test("Engine runtimes.validate 走统一验证器入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-validate-")); roots.push(root);
  const seen: { cli: string; executablePath: string }[] = [];
  const executablePath = join(root, "kimi"); await writeFile(executablePath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async (cli, input) => {
      seen.push({ cli, executablePath: input.executablePath });
      return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: "kimi 2.1.1", discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
    },
  });
  try {
    const response = await engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "kimi" }) as { runtime: { cli: string } };
    expect(response.runtime.cli).toBe("kimi");
    expect(seen).toEqual([{ cli: "kimi", executablePath }]);
    const listed = await engine.handleDesktopAction("runtimes.list", {}) as { runtimes: { cli: string }[] };
    expect(listed.runtimes).toHaveLength(1);
  } finally { engine.shutdown(); }
});
