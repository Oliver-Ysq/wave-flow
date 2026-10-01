import { describe, expect, test } from "bun:test";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 第 1 章规定的职责目录；目录是后续实现的唯一落点，而非能力已经可用的声明。 */
const requiredDirectories = [
  "src/workflow",
  "src/runtime",
  "src/sessions",
  "src/sessions/backends",
  "src/sessions/bootstrap",
  "src/adapters",
  "src/control",
  "src/journal",
  "src/daemon",
  "src/cli",
  "src/web",
  "src/shared",
] as const;

describe("第 1 章：新架构目录与历史实现边界", () => {
  test("为每个职责提供唯一且可追踪的目录落点", async () => {
    await Promise.all(requiredDirectories.map(async (directory) => {
      const path = join(projectRoot, directory);
      const entry = await stat(path);
      expect(entry.isDirectory()).toBe(true);
      await expect(access(join(path, "README.md")).catch(() => access(join(path, ".gitkeep")))).resolves.toBeDefined();
    }));
  });

  test("源码树不再包含一次性 exec Runtime、Fake Adapter 或旧事件层", async () => {
    const sourceEntries = await readdir(join(projectRoot, "src"));
    expect(sourceEntries).not.toContain("events");

    await expect(access(join(projectRoot, "src/adapters/codex-cli"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/adapters/testing"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/runtime/runner.ts"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/cli/main.ts"))).rejects.toThrow();
  });
});
