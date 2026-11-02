import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchMarkerPath, readLaunchState, removeLaunchFiles, reportPathFor, writerLaunchKey } from "../../src/runtimes/supervisor-report";
import { reportLaunchMarker, reportProviderPid } from "../../src/runtimes/worker-supervisor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

test("supervisor 报告区分未启动、启动中与 provider 已创建", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wave-flow-supervisor-report-")); directories.push(directory);
  const path = reportPathFor(writerLaunchKey("run", "node", "session"), directory);
  expect(await readLaunchState(path)).toEqual({ kind: "missing" });

  reportLaunchMarker(path, process.pid);
  expect(await readLaunchState(path)).toEqual({ kind: "launching", supervisorPid: process.pid });
  expect(await Bun.file(launchMarkerPath(path)).exists()).toBe(true);

  reportProviderPid(path, 43210, "1792645200:363555");
  expect(await readLaunchState(path)).toEqual({ kind: "provider", pgid: 43210, startedAt: "1792645200:363555" });

  await removeLaunchFiles(path);
  expect(await readLaunchState(path)).toEqual({ kind: "missing" });
  expect(await Bun.file(path).exists()).toBe(false);
});

test("launch key 对同一 Run/节点/会话稳定，对不同会话不同", () => {
  const first = writerLaunchKey("run", "node", "session-a");
  expect(writerLaunchKey("run", "node", "session-a")).toBe(first);
  expect(writerLaunchKey("run", "node", "session-b")).not.toBe(first);
  expect(writerLaunchKey("run", "other", "session-a")).not.toBe(first);
});

test("新的启动标记会覆盖上一代 provider 报告，避免旧 pgid 被当成本次结果", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wave-flow-supervisor-report-")); directories.push(directory);
  const path = reportPathFor(writerLaunchKey("run", "node", "session"), directory);
  reportProviderPid(path, 43210, "1792645200:363555");
  reportLaunchMarker(path, process.pid);
  expect(await readLaunchState(path)).toEqual({ kind: "launching", supervisorPid: process.pid });
});
