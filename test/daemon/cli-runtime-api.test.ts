import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { runsRoot } from "../../src/journal/paths";
import { verifyExecutable } from "../../src/runtimes/identity";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";

const roots: string[] = []; const daemons: LocalDaemon[] = [];
afterEach(async () => { daemons.splice(0).forEach(item => item.stop()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("Runtime API 只接受用户触发的空扫描请求，并且默认 runtime 为空", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-api-")); roots.push(root);
  const daemon = new LocalDaemon({ deterministicForTest: true, storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs") }); daemons.push(daemon); const server = daemon.start();
  await expect(fetch(`${server.baseUrl}/cli-runtimes`).then(response => response.json())).resolves.toEqual({ selectedByCli: {}, runtimes: [] });
  await expect(fetch(`${server.baseUrl}/daemon/status`).then(response => response.json())).resolves.toEqual({ protocolVersion: 3, activeRuns: 0, blockedRuns: 0, activeHarnesses: 0, acpWorkersNeedingResume: 0 });
  const invalid = await fetch(`${server.baseUrl}/cli-runtimes/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shell: "bad" }) });
  expect(invalid.status).toBe(400);
});

test("启动扫描验证并保存多个候选，但绝不选择或替换默认主控", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-scan-api-")); roots.push(root);
  const paths = [join(root, "codex-a"), join(root, "codex-b")];
  await Promise.all(paths.map(path => Bun.write(path, "#!/bin/sh\nexit 0\n")));
  await Promise.all(paths.map(path => Bun.spawn(["chmod", "700", path]).exited));
  const record = async (path: string): Promise<CliRuntimeRecord> => {
    const executable = await verifyExecutable(path);
    return { runtimeId: `runtime-${path.endsWith("a") ? "a" : "b"}`, cli: "codex", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "codex 1.0", discoveredFrom: "shell-path", discoveredShell: "/bin/zsh", verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
  };
  const daemon = new LocalDaemon({ deterministicForTest: true, storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs"), discoverCliRuntimes: async () => paths.map(executablePath => ({ executablePath, discoveredFrom: "shell-path" as const, discoveredShell: "/bin/zsh", aliases: [] })), validateCliRuntime: async candidate => record(candidate.executablePath) }); daemons.push(daemon);
  const server = daemon.start();
  const scan = async () => fetch(`${server.baseUrl}/cli-runtimes/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json() as Promise<{ discovered: number; verified: number; runtimes: { selectedByCli: Record<string, string>; runtimes: CliRuntimeRecord[] } }>);
  const first = await scan();
  expect(first.discovered).toBe(2); expect(first.verified).toBe(2); expect(first.runtimes.selectedByCli).toEqual({});
  const select = await fetch(`${server.baseUrl}/cli-runtimes/runtime-a/select`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(select.status).toBe(200);
  const again = await scan();
  expect(again.runtimes.selectedByCli).toEqual({ codex: "runtime-a" });
  const switchAttempt = await fetch(`${server.baseUrl}/cli-runtimes/runtime-b/select`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(switchAttempt.status).toBe(400); expect((await switchAttempt.json() as { error: string }).error).toContain("后续版本");
});

test("新 daemon 将旧 ACP active 节点收敛为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-acp-restart-")); roots.push(root);
  const store = runsRoot(root);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "restart", description: "restart", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(root, "workflow.ts"), workflowProjectCwd: root, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, store);
  const request = { id: "worker", cli: "codex" as const, sandbox: "workspace-write" as const, cwd: root, prompt: "work", phase: "run" };
  const agent: JournalEvent = { type: "agent.created", at: manifest.createdAt, runId: manifest.runId, nodeId: "worker", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  const running: JournalEvent = { type: "agent.status", at: manifest.createdAt, runId: manifest.runId, nodeId: "worker", agentSessionId: "old-session", diagnostic: null, status: "running" };
  const binding: JournalEvent = { type: "agent.session", at: manifest.createdAt, runId: manifest.runId, nodeId: "worker", agentSessionId: "old-session", diagnostic: "acp", delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "native-old", capabilities: {} } };
  for (const event of [agent, running, binding]) await journal.append(event);
  const daemon = new LocalDaemon({ deterministicForTest: true, storeRoot: store, harnessRoot: join(root, "harness-runs") }); daemons.push(daemon);
  daemon.start();
  await daemon.convergeStaleAcpWorkers();
  const reopened = await RunJournal.open(manifest.runId, store);
  expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.status", nodeId: "worker", status: "interrupted" }));
  expect(reopened.events).toContainEqual(expect.objectContaining({ type: "run.status", status: "interrupted" }));
});
