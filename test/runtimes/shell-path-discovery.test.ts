import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPath, ShellPathDiscovery } from "../../src/runtimes/shell-path-discovery";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("只提取随机 marker 中的 PATH，忽略 ANSI 与其他环境行", () => {
  expect(extractPath("noise\n__WAVE_FLOW_PATH_a__\nHOME=/Users/test\n\x1b[32mPATH=/one:/two\x1b[0m\n__WAVE_FLOW_PATH_a__\nPATH=/outside")).toBe("/one:/two");
});

test("受控 shell 输出可将 PATH 候选交给 identity 去重", async () => {
  const discovery = new ShellPathDiscovery(async () => ({ stdout: "__WAVE_FLOW_PATH_a__\nPATH=/definitely/not/codex\n__WAVE_FLOW_PATH_a__", stderr: "", exitCode: 0 }), "");
  await expect(discovery.discover()).resolves.toEqual([]);
});

test("PATH 中同时发现 codex 与 kimi 并按 cli 标注", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-discovery-")); roots.push(root);
  for (const name of ["codex", "kimi"]) { const path = join(root, name); await writeFile(path, `#!/bin/sh\necho ${name}\n`, { mode: 0o700 }); await chmod(path, 0o700); }
  const discovery = new ShellPathDiscovery(async () => ({ stdout: `__WAVE_FLOW_PATH_a__\nPATH=${root}\n__WAVE_FLOW_PATH_a__`, stderr: "", exitCode: 0 }), "");
  const candidates = await discovery.discover();
  expect(candidates.map(item => item.cli).sort()).toEqual(["codex", "kimi"]);
  const canonical = await realpath(root);
  for (const candidate of candidates) {
    expect(candidate.executablePath).toBe(join(canonical, candidate.cli));
    expect(candidate.discoveredFrom).toBe("shell-path");
  }
});
