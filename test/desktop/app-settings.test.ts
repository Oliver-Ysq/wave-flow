import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettingsStore, DEFAULT_APP_SETTINGS } from "../../src/desktop/app-settings";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

/** 每个用例独立真实目录；AppSettingsStore 的 root 在测试中显式注入。 */
async function storeRoot(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-settings-test-")));
  roots.push(path);
  return path;
}

test("设置文件缺失时默认开启感知模式，写入后可读取且文件权限私有", async () => {
  const root = await storeRoot();
  const store = new AppSettingsStore(root);
  expect(DEFAULT_APP_SETTINGS).toEqual({ perceptionMode: true });
  expect(await store.get()).toEqual({ perceptionMode: true });
  expect(await store.update({ perceptionMode: false })).toEqual({ perceptionMode: false });
  expect(await store.get()).toEqual({ perceptionMode: false });
  const file = join(root, "settings.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ perceptionMode: false });
  const info = await lstat(file);
  // 设置可能包含用户偏好，必须固定为当前用户私有，不能组/其他用户可读写。
  expect(info.mode & 0o077).toBe(0);
  // 并发更新不应留下临时文件。
  expect(await readdir(root)).toEqual(["settings.json"]);
});

test("非法 JSON、未知字段与非布尔值在读写两侧都拒绝，不静默回退", async () => {
  const root = await storeRoot();
  const store = new AppSettingsStore(root);
  const file = join(root, "settings.json");
  // 写入侧：非对象、未知字段、非布尔值在任何落盘前拒绝。
  await expect(store.update(null)).rejects.toThrow("对象");
  await expect(store.update([])).rejects.toThrow("对象");
  await expect(store.update({ perceptionMode: "true" })).rejects.toThrow("布尔");
  await expect(store.update({ perceptionMode: 1 })).rejects.toThrow("布尔");
  await expect(store.update({ unknown: true })).rejects.toThrow("未知");
  expect(await Bun.file(file).exists()).toBe(false);
  // 读取侧：损坏或带未知字段的文件抛错，而不是假装默认值。
  await writeFile(file, "{not json");
  await expect(store.get()).rejects.toThrow("JSON");
  await writeFile(file, JSON.stringify({ perceptionMode: true, extra: 1 }));
  await expect(store.get()).rejects.toThrow("未知字段");
  await writeFile(file, JSON.stringify({ perceptionMode: "yes" }));
  await expect(store.get()).rejects.toThrow("布尔");
  await writeFile(file, JSON.stringify([]));
  await expect(store.get()).rejects.toThrow("JSON 对象");
});

test("并发更新按调用顺序串行落盘，最后一次写入是最终值", async () => {
  const root = await storeRoot();
  const store = new AppSettingsStore(root);
  // 20 个并发更新；串行链保证最终值一定来自最后入队的一次（index 19 → true）。
  const writes = Array.from({ length: 20 }, (_, index) => store.update({ perceptionMode: index % 2 === 1 }));
  expect(await Promise.all(writes)).toHaveLength(20);
  expect(await store.get()).toEqual({ perceptionMode: true });
  const file = join(root, "settings.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ perceptionMode: true });
  // 串行链不残留中间临时文件。
  expect((await readdir(root)).filter(name => name !== "settings.json")).toEqual([]);
});
