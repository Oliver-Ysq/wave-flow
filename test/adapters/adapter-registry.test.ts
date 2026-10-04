import { describe, expect, test } from "bun:test";
import { AdapterRegistry, type CodexControlTransport, type RegisteredInteractiveAdapter } from "../../src/adapters/adapter-registry";
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

function entry(controlTransport: CodexControlTransport = "tmux-tui"): RegisteredInteractiveAdapter {
  return { cli: "codex", controlTransport, adapter: new FakeCodexAdapter(), probeCapabilities: async () => capabilities };
}

describe("AdapterRegistry", () => {
  test("按 cli/控制传输精确注册与解析，不将未知传输回退到 tmux-tui", () => {
    const registry = new AdapterRegistry(); registry.register(entry());
    expect(registry.resolve("codex", "tmux-tui").adapter.id).toBe("fake-codex");
    expect(() => registry.resolve("codex", "app-server-bridged")).toThrow("未注册的 Adapter 控制传输：codex/app-server-bridged");
    expect(registry.entries()).toHaveLength(1);
  });

  test("拒绝重复控制传输、CLI 不一致与缺失 capability 探测器", () => {
    const registry = new AdapterRegistry(); registry.register(entry());
    expect(() => registry.register(entry())).toThrow("已注册");
    expect(() => new AdapterRegistry().register({ ...entry(), cli: "traex" as never })).toThrow("CLI 不一致");
    expect(() => new AdapterRegistry().register({ ...entry(), probeCapabilities: undefined as never })).toThrow("缺少 capability 探测器");
  });

  test("Codex 工厂只生成 tmux-tui 注册项，未知控制传输必须等待独立实现", async () => {
    const sessions: SessionBackend = {
      async create(_options: CreateSessionOptions) { throw new Error("not used"); }, async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "missing" as SessionLiveness; }, async detach() {}, async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
    };
    const registry = new AdapterRegistry(); registry.register(codexTmuxTuiRegistration(new CodexInteractiveAdapter(sessions), async () => capabilities));
    expect(registry.resolve("codex", "tmux-tui").controlTransport).toBe("tmux-tui");
    expect(() => registry.resolve("codex", "app-server-bridged")).toThrow("未注册");
  });
});
