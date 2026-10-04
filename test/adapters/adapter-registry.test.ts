import { describe, expect, test } from "bun:test";
import { AdapterRegistry, type CodexCliBase, type RegisteredInteractiveAdapter } from "../../src/adapters/adapter-registry";
import type { AdapterCapabilities } from "../../src/adapters/capabilities";
import type { InteractiveCliAdapter, InteractiveCliLaunchPlan, InteractiveCliStartRequest, PromptReadyEvidence, PromptSubmissionEvidence } from "../../src/adapters/interactive-cli-adapter";
import type { SessionIdentity } from "../../src/sessions/types";
import { CodexInteractiveAdapter, codexTmuxTuiRegistration } from "../../src/adapters/codex-interactive-adapter";
import type { SessionBackend, SessionLiveness, CreateSessionOptions, DestroyResult } from "../../src/sessions/types";

const capabilities: AdapterCapabilities = {
  status: "available", interactiveSession: "available", verifiedPromptDelivery: "available", persistentTmuxSession: "available",
  sandbox: { readOnly: "available", workspaceWrite: "available" },
};

class FakeCodexAdapter implements InteractiveCliAdapter {
  readonly id = "fake-codex";
  readonly cli = "codex" as const;
  async launch(_request: InteractiveCliStartRequest, _signal: AbortSignal): Promise<InteractiveCliLaunchPlan> { return { command: ["codex"] }; }
  async waitUntilReady(_request: InteractiveCliStartRequest, _plan: InteractiveCliLaunchPlan, _identity: SessionIdentity, _signal: AbortSignal): Promise<PromptReadyEvidence> { return { ready: true, diagnostic: "ready" }; }
  async submitInitialPrompt(_request: InteractiveCliStartRequest, _plan: InteractiveCliLaunchPlan, _identity: SessionIdentity, _signal: AbortSignal): Promise<void> {}
  async confirmInitialPrompt(_request: InteractiveCliStartRequest, _plan: InteractiveCliLaunchPlan, _identity: SessionIdentity, _signal: AbortSignal): Promise<PromptSubmissionEvidence> { return { submitted: true, proof: "native-history", cliSessionId: "session", diagnostic: "confirmed" }; }
}

function entry(cliBase: CodexCliBase = "tmux-tui"): RegisteredInteractiveAdapter {
  return { cli: "codex", cliBase, adapter: new FakeCodexAdapter(), probeCapabilities: async () => capabilities };
}

describe("AdapterRegistry", () => {
  test("按 cli/cliBase 精确注册与解析，不将 app-server 回退到 tmux-tui", () => {
    const registry = new AdapterRegistry(); registry.register(entry());
    expect(registry.resolve("codex", "tmux-tui").adapter.id).toBe("fake-codex");
    expect(() => registry.resolve("codex", "app-server")).toThrow("未注册的 Adapter CLI Base：codex/app-server");
    expect(registry.entries()).toHaveLength(1);
  });

  test("拒绝重复 CLI Base、CLI 不一致与缺失 capability 探测器", () => {
    const registry = new AdapterRegistry(); registry.register(entry());
    expect(() => registry.register(entry())).toThrow("已注册");
    expect(() => new AdapterRegistry().register({ ...entry(), cli: "traex" as never })).toThrow("CLI 不一致");
    expect(() => new AdapterRegistry().register({ ...entry(), probeCapabilities: undefined as never })).toThrow("缺少 capability 探测器");
    expect(() => new AdapterRegistry().register(entry("app-server"))).toThrow("当前版本不允许注册");
  });

  test("P1 只有显式放开并完成独立实现后才可注册 app-server CLI Base", () => {
    const registry = new AdapterRegistry(new Set(["tmux-tui", "app-server"]));
    registry.register(entry("app-server"));
    expect(registry.resolve("codex", "app-server").cliBase).toBe("app-server");
  });

  test("Codex 工厂只生成 tmux-tui 注册项，App Server 必须等待独立 Adapter", async () => {
    const sessions: SessionBackend = {
      async create(_options: CreateSessionOptions) { throw new Error("not used"); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "missing" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const registry = new AdapterRegistry(); registry.register(codexTmuxTuiRegistration(new CodexInteractiveAdapter(sessions), async () => capabilities));
    expect(registry.resolve("codex", "tmux-tui").cliBase).toBe("tmux-tui");
    expect(() => registry.resolve("codex", "app-server")).toThrow("未注册");
  });
});
