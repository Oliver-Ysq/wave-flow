import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectNodeRuntime } from "../../src/runtimes/node-runtime";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fakeNode(name: string, output: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-node-select-")); roots.push(root);
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  await chmod(path, 0o755);
  return path;
}

test("声明下限时跳过过旧候选，选中首个满足 minNodeVersion 的 node", async () => {
  const oldNode = await fakeNode("node22", "v22.17.1");
  const goodNode = await fakeNode("node24", "v24.22.0");
  const selected = await selectNodeRuntime([oldNode, goodNode], 24);
  expect(selected.executablePath).toBe(await realpath(goodNode));
});

test("未声明下限时保持首个可验证候选，不主动升级解释器", async () => {
  const first = await fakeNode("node20", "v20.19.2");
  const second = await fakeNode("node24", "v24.22.0");
  const selected = await selectNodeRuntime([first, second]);
  expect(selected.executablePath).toBe(await realpath(first));
});

test("没有候选满足下限时如实报告最高版本，不把未知当满足", async () => {
  const oldNode = await fakeNode("node22", "v22.17.1");
  const newerOld = await fakeNode("node23", "v23.9.0");
  const unparsable = await fakeNode("node-broken", "not-a-version");
  await expect(selectNodeRuntime([oldNode, unparsable, newerOld], 24)).rejects.toThrow("找到的最高版本为 v23");
});

test("候选不存在或不可执行时继续查找后续候选", async () => {
  const missing = "/definitely/not/a/node";
  const goodNode = await fakeNode("node24", "v24.22.0");
  const selected = await selectNodeRuntime([missing, goodNode], 24);
  expect(selected.executablePath).toBe(await realpath(goodNode));
});
