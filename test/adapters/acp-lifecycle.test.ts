import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acpLifecycleLogPath, logAcpLifecycle } from "../../src/adapters/acp-lifecycle-log";

async function waitForLog(path: string, expectedLines: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const content = await readFile(path, "utf8");
      if (content.trim().split("\n").filter(Boolean).length >= expectedLines) return content;
    } catch { /* 文件尚未创建 */ }
    await Bun.sleep(10);
  }
  throw new Error("ACP 生命周期日志未在预期时间内写入。");
}

async function waitForMode(path: string, expected: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const mode = (await stat(path)).mode & 0o777;
      if (mode === expected) return mode;
    } catch { /* 文件/目录尚未创建 */ }
    await Bun.sleep(10);
  }
  return (await stat(path)).mode & 0o777;
}

test("ACP 生命周期日志以私有 JSONL 记录 spawn/exit 与信号", async () => {
  const root = await mkdtemp(join(tmpdir(), "wf-acp-lifecycle-"));
  try {
    logAcpLifecycle({ event: "spawn", launcher: "codex", pid: 123 }, root);
    logAcpLifecycle({ event: "exit", launcher: "codex", pid: 123, code: 137, signal: "SIGKILL", stderr: "adapter died" }, root);
    const path = acpLifecycleLogPath(root);
    const lines = (await waitForLog(path, 2)).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "spawn", launcher: "codex", pid: 123 });
    expect(lines[1]).toMatchObject({ event: "exit", code: 137, signal: "SIGKILL", stderr: "adapter died" });
    expect(await waitForMode(path, 0o600)).toBe(0o600);
    expect(await waitForMode(join(root, "logs"), 0o700)).toBe(0o700);
  } finally {
    await chmod(join(root, "logs"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
