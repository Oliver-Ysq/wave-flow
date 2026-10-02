import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxCommandClient, type TmuxCommandRunner } from "../../src/sessions/backends/tmux-command";
import { TmuxSessionBackend } from "../../src/sessions/backends/tmux-session-backend";

describe("TmuxSessionBackend identity 回滚", () => {
  test("identity 文件写入失败后终止刚创建的会话", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-tmux-"));
    try {
      const identityFile = join(cwd, "identity-directory");
      await mkdir(identityFile);
      const calls: string[][] = [];
      const runner: TmuxCommandRunner = { run: async (args) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
      const backend = new TmuxSessionBackend(new TmuxCommandClient(join(cwd, "socket"), runner));
      await expect(backend.create({ runId: "22222222-2222-4222-8222-222222222222", nodeId: "node", cli: "codex", cwd, command: ["/bin/sh"], identityFile })).rejects.toThrow();
      expect(calls.some((args) => args.includes("new-session"))).toBe(true);
      expect(calls.some((args) => args.includes("kill-session"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
