import { describe, expect, test } from "bun:test";
import { isCapabilityAvailable, requireCapabilities } from "../../src/adapters/capabilities";
import { probeCapabilities, type CapabilityCommandRunner } from "../../src/daemon/capability-probe";

describe("Capabilities", () => {
  test("unknown 与 unavailable 均 fail closed", () => {
    expect(isCapabilityAvailable("available")).toBe(true);
    expect(isCapabilityAvailable("unknown")).toBe(false);
    expect(() => requireCapabilities({ tmux: "available", prompt: "unknown" })).toThrow("prompt=unknown");
    expect(() => requireCapabilities({ codex: "unavailable" })).toThrow("codex=unavailable");
  });

  test("二进制可用不冒充交互会话、Prompt 或 sandbox 已验证", async () => {
    const runner: CapabilityCommandRunner = { run: async () => ({ exitCode: 0 }) };
    const snapshot = await probeCapabilities(runner);
    expect(snapshot).toMatchObject({
      host: { tmux: { status: "available", persistentSessions: "unavailable" } },
      adapters: { codex: { status: "available", interactiveSession: "unavailable", verifiedPromptDelivery: "unavailable", sandbox: { readOnly: "unknown", workspaceWrite: "unknown" } } },
    });
  });

  test("命令缺失为 unavailable，探测异常为 unknown", async () => {
    const missing: CapabilityCommandRunner = { run: async () => { const error = Object.assign(new Error("missing"), { code: "ENOENT" }); throw error; } };
    await expect(probeCapabilities(missing)).resolves.toMatchObject({ host: { tmux: { status: "unavailable" } }, adapters: { codex: { status: "unavailable" } } });
    const unknown: CapabilityCommandRunner = { run: async () => { throw new Error("timeout"); } };
    await expect(probeCapabilities(unknown)).resolves.toMatchObject({ host: { tmux: { status: "unknown" } }, adapters: { codex: { status: "unknown" } } });
  });

  test("探测超时必须返回 unknown，而不能无限阻塞 capabilities 命令", async () => {
    const hanging: CapabilityCommandRunner = { run: async () => new Promise(() => undefined) };
    await expect(probeCapabilities(hanging, 1)).resolves.toMatchObject({ host: { tmux: { status: "unknown" } }, adapters: { codex: { status: "unknown" } } });
  });
});
