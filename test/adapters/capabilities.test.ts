import { describe, expect, test } from "bun:test";
import { isCapabilityAvailable, requireCapabilities } from "../../src/adapters/capabilities";
import { probeCapabilities, type CapabilityCommandRunner } from "../../src/daemon/capability-probe";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Capabilities", () => {
  test("unknown 与 unavailable 均 fail closed", () => {
    expect(isCapabilityAvailable("available")).toBe(true);
    expect(isCapabilityAvailable("unknown")).toBe(false);
    expect(() => requireCapabilities({ tmux: "available", prompt: "unknown" })).toThrow("prompt=unknown");
    expect(() => requireCapabilities({ codex: "unavailable" })).toThrow("codex=unavailable");
  });

  test("二进制可用但未实际启动时，交互会话与 Prompt 只报告 unknown", async () => {
    let exists = false;
    let marker = "";
    const runner: CapabilityCommandRunner = { run: async (_command, args, _timeout, stdin) => {
      if (args.includes("new-session")) exists = true;
      if (args.includes("kill-session")) exists = false;
      if (args.includes("has-session")) return exists ? { exitCode: 0 } : { exitCode: 1, stderr: "can't find session" };
      if (args.includes("load-buffer")) marker = stdin?.trim() ?? "";
      if (args.includes("capture-pane")) return { exitCode: 0, stdout: marker };
      return { exitCode: 0 };
    } };
    const snapshot = await probeCapabilities(runner);
    expect(snapshot).toMatchObject({
      host: { tmux: { status: "available", persistentSessions: "available" } },
      adapters: { codex: { status: "available", interactiveSession: "unknown", verifiedPromptDelivery: "unknown", sandbox: { readOnly: "unknown", workspaceWrite: "unknown" } } },
    });
  });

  test("命令缺失为 unavailable，探测异常为 unknown", async () => {
    const missing: CapabilityCommandRunner = { run: async () => { const error = Object.assign(new Error("missing"), { code: "ENOENT" }); throw error; } };
    await expect(probeCapabilities(missing)).resolves.toMatchObject({ host: { tmux: { status: "unavailable", persistentSessions: "unavailable" } }, adapters: { codex: { status: "unavailable" } } });
    const unknown: CapabilityCommandRunner = { run: async () => { throw new Error("timeout"); } };
    await expect(probeCapabilities(unknown)).resolves.toMatchObject({ host: { tmux: { status: "unknown", persistentSessions: "unknown" } }, adapters: { codex: { status: "unknown" } } });
  });

  test("Codex 存在但 tmux 不可用时，不把交互会话误报为 available", async () => {
    const runner: CapabilityCommandRunner = { run: async (command) => {
      if (command === "tmux") return { exitCode: 127, stderr: "not found" };
      return { exitCode: 0 };
    } };
    await expect(probeCapabilities(runner)).resolves.toMatchObject({ adapters: { codex: { status: "available", interactiveSession: "unavailable", verifiedPromptDelivery: "unavailable", persistentTmuxSession: "unavailable" } } });
  });

  test("探测超时必须返回 unknown，而不能无限阻塞 capabilities 命令", async () => {
    const hanging: CapabilityCommandRunner = { run: async () => new Promise(() => undefined) };
    await expect(probeCapabilities(hanging, 1)).resolves.toMatchObject({ host: { tmux: { status: "unknown" } }, adapters: { codex: { status: "unknown" } } });
  });

  test("真实私有 tmux 探测完成后不保留新的 socket server", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const socketDirectory = join(process.env.XDG_RUNTIME_DIR || join(tmpdir(), `wave-flow-tmux-${uid}`), "wave-flow");
    const before = new Set(await readdir(socketDirectory).catch(() => []));
    const snapshot = await probeCapabilities();
    expect(snapshot.host.tmux.status).toBe("available");
    const after = await readdir(socketDirectory).catch(() => []);
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});
