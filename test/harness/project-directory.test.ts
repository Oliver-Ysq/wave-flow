import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessProjectStore, validateProjectDirectory } from "../../src/harness/projects";
test("项目只接纳现有绝对目录，普通文件与相对路径零落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "wf-project-directory-"));
  try {
    const store = new HarnessProjectStore(join(root, "state"));
    const file = join(root, "file"); await writeFile(file, "not a directory");
    await expect(store.create(file)).rejects.toThrow("文件夹");
    await expect(store.create("relative")).rejects.toThrow("绝对路径");
    await expect(store.create(join(root, "missing"))).rejects.toThrow("不可验证");
    expect(await store.list()).toEqual([]);
    const cwd = await validateProjectDirectory(root);
    expect(await store.list()).toEqual([]);
    const first = await store.create(cwd);
    expect((await store.create(cwd)).projectId).toBe(first.projectId);
    expect(await store.list()).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
