import { expect, test } from "bun:test";
import { extractPath, ShellPathDiscovery } from "../../src/runtimes/shell-path-discovery";

test("只提取随机 marker 中的 PATH，忽略 ANSI 与其他环境行", () => {
  expect(extractPath("noise\n__WAVE_FLOW_PATH_a__\nHOME=/Users/test\n\x1b[32mPATH=/one:/two\x1b[0m\n__WAVE_FLOW_PATH_a__\nPATH=/outside")).toBe("/one:/two");
});

test("受控 shell 输出可将 PATH 候选交给 identity 去重", async () => {
  const discovery = new ShellPathDiscovery(async () => ({ stdout: "__WAVE_FLOW_PATH_a__\nPATH=/definitely/not/codex\n__WAVE_FLOW_PATH_a__", stderr: "", exitCode: 0 }), "");
  await expect(discovery.discover()).resolves.toEqual([]);
});
