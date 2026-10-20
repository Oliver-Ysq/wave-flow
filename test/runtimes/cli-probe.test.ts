import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PROBE_LIMIT, describeProbeStatus, probeFirstRunnable } from "../../src/runtimes/cli-probe";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fakeCli(root: string, name: string, output: string, exit = 0): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\necho ${JSON.stringify(output)}\nexit ${exit}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("第一个能跑的候选胜出并返回版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-probe-")); roots.push(root);
  const broken = await fakeCli(root, "broken", "boom", 1);
  const good = await fakeCli(root, "good", "codex-cli 9.9.9");
  const result = await probeFirstRunnable([broken, good]);
  expect(result.status).toBe("available");
  expect(result.binary).toBe(good);
  expect(result.version).toBe("codex-cli 9.9.9");
  expect(result.probed).toBe(2);
});

test("全部可执行但都失败时报 exec_failed，不折叠成不存在", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-probe-fail-")); roots.push(root);
  const a = await fakeCli(root, "a", "nope", 2);
  const b = await fakeCli(root, "b", "nope", 3);
  const result = await probeFirstRunnable([a, b]);
  expect(result.status).toBe("exec_failed");
  expect(result.binary).toBe(b);
});

test("可执行文件不存在时报 absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-probe-absent-")); roots.push(root);
  const result = await probeFirstRunnable([join(root, "missing")]);
  expect(result.status).toBe("absent");
});

test("超过候选上限且都不可用时返回 limit_reached，最多探测 4 个", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-probe-limit-")); roots.push(root);
  const paths: string[] = [];
  for (let index = 0; index < CLI_PROBE_LIMIT + 2; index += 1) paths.push(await fakeCli(root, `bad-${index}`, "nope", 1));
  const result = await probeFirstRunnable(paths);
  expect(result.status).toBe("limit_reached");
  expect(result.probed).toBe(CLI_PROBE_LIMIT);
});

test("探测结论有可行动的中文说明", () => {
  expect(describeProbeStatus("absent")).toBe("未找到可执行文件");
  expect(describeProbeStatus("timeout")).toContain("超时");
  expect(describeProbeStatus("exec_failed")).toContain("--version");
  expect(describeProbeStatus("limit_reached")).toContain(String(CLI_PROBE_LIMIT));
});
