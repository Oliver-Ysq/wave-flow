import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceAcpNodeWriters } from "../../src/runtime/acp-writer-fence";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import { launchMarkerPath, reportPathFor, writerLaunchKey } from "../../src/runtimes/supervisor-report";
import { reportLaunchMarker, reportProviderPid } from "../../src/runtimes/worker-supervisor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function reportDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wave-flow-fence-report-"));
  directories.push(directory);
  return directory;
}
const RUN = crypto.randomUUID(), SESSION = "session-1";
function intentNode(): AgentNodeSnapshot {
  return { id: "node", status: "interrupted", agentSessionId: SESSION, writer: null, writerIntentAt: "2026-11-01T00:00:00.000Z" } as unknown as AgentNodeSnapshot;
}
function reportPath(directory: string): string { return reportPathFor(writerLaunchKey(RUN, "node", SESSION), directory); }

test("启动意图没有 supervisor 启动记录时判定 provider 未创建", async () => {
  const directory = await reportDir();
  const result = await fenceAcpNodeWriters(RUN, [intentNode()], { reportDir: directory });
  expect(result.failures).toEqual([]);
  expect(result.checked).toBe(0);
});

test("启动意图只剩启动标记且 supervisor 已退出时判定 provider 未创建", async () => {
  const directory = await reportDir(), path = reportPath(directory);
  reportLaunchMarker(path, 2_000_000_000);
  expect(await Bun.file(launchMarkerPath(path)).exists()).toBe(true);
  const result = await fenceAcpNodeWriters(RUN, [intentNode()], { reportDir: directory });
  expect(result.failures).toEqual([]);
  expect(result.checked).toBe(0);
});

test("启动意图有 provider 报告时按报告围栏，并删除报告", async () => {
  const directory = await reportDir(), path = reportPath(directory);
  reportLaunchMarker(path, 2_000_000_000);
  reportProviderPid(path, 2_000_000_000, "1:2");
  const result = await fenceAcpNodeWriters(RUN, [intentNode()], { reportDir: directory });
  expect(result.failures).toEqual([]);
  expect(result.checked).toBe(1);
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await Bun.file(launchMarkerPath(path)).exists()).toBe(false);
});

test("启动中等待 supervisor 写出 provider 报告后再围栏", async () => {
  const directory = await reportDir(), path = reportPath(directory);
  reportLaunchMarker(path, process.pid);
  setTimeout(() => reportProviderPid(path, 2_000_000_000, "1:2"), 60);
  const result = await fenceAcpNodeWriters(RUN, [intentNode()], { reportDir: directory });
  expect(result.failures).toEqual([]);
  expect(result.checked).toBe(1);
});

test("启动中 supervisor 始终不报告 provider 时先收尾再判定", async () => {
  const directory = await reportDir(), path = reportPath(directory);
  const supervisor = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    reportLaunchMarker(path, supervisor.pid);
    const result = await fenceAcpNodeWriters(RUN, [intentNode()], { reportDir: directory });
    expect(result.failures).toEqual([]);
    expect(result.checked).toBe(0);
    await Promise.race([supervisor.exited, Bun.sleep(2_000)]);
    expect(supervisor.exitCode !== null || supervisor.signalCode !== null).toBe(true);
  } finally {
    try { process.kill(supervisor.pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
}, 15_000);

test("没有 writer 也没有意图的旧档案不做围栏", async () => {
  const directory = await reportDir();
  const node = { id: "node", status: "interrupted", writer: null, writerIntentAt: null } as unknown as AgentNodeSnapshot;
  const result = await fenceAcpNodeWriters(RUN, [node], { reportDir: directory });
  expect(result.failures).toEqual([]);
  expect(result.checked).toBe(0);
});
