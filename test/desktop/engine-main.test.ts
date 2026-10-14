import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";

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
      const current = await next() as { result: { harness: { status: string } } };
      if (current.result.harness.status !== "running") return;
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
