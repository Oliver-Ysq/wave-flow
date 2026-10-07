import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxSessionBackend } from "../../src/sessions/backends/tmux-session-backend";
import { privateTmuxSocketPath, TmuxCommandClient } from "../../src/sessions/backends/tmux-command";
import { TmuxTerminalObserver } from "../../src/sessions/terminal-observer";
import type { SessionIdentity } from "../../src/sessions/types";

const directories: string[] = [];
const resources: Array<{ readonly backend: TmuxSessionBackend; readonly identity: SessionIdentity; readonly client: TmuxCommandClient }> = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ backend, identity, client }) => { await backend.destroy(identity).catch(() => {}); await client.closePrivateServer().catch(() => {}); }));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-terminal-")); directories.push(cwd);
  const client = new TmuxCommandClient(privateTmuxSocketPath(cwd, crypto.randomUUID()));
  const backend = new TmuxSessionBackend(client);
  const identity = await backend.create({ runId: "11111111-1111-4111-8111-111111111111", nodeId: "terminal", agentSessionId: "session", cli: "codex", cwd, command: ["/bin/sh", "-c", "printf 'BOOT\\n'; while IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done"] });
  resources.push({ backend, identity, client });
  await Bun.sleep(80);
  return { backend, identity };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("等待终端输出超时。"); await Bun.sleep(20); }
}

describe("TmuxTerminalObserver", () => {
  test("以 ANSI 首屏和 pipe-pane 实时输出观察受管会话，关闭观察不停止 Agent", async () => {
    const { backend, identity } = await fixture();
    const observer = new TmuxTerminalObserver(identity);
    await observer.start();
    const initial = await observer.initialScreen();
    expect(initial.screen).toContain("BOOT");
    expect(initial.screen).not.toMatch(/(?<!\r)\n/);
    const output: string[] = [];
    const unsubscribe = observer.subscribe((data) => output.push(data));
    await observer.input("hello"); await observer.input("\r");
    await waitFor(() => output.join("").includes("ECHO:hello"));
    unsubscribe(); await observer.close();
    await expect(backend.liveness(identity)).resolves.toBe("exists");
    await backend.sendText(identity, "still-alive\n"); await Bun.sleep(60);
    await expect(backend.readRecent(identity)).resolves.toContain("ECHO:still-alive");
  });

  test("被篡改 identity 时拒绝读取、订阅和输入", async () => {
    const { identity } = await fixture();
    const observer = new TmuxTerminalObserver({ ...identity, agentSessionId: "forged" });
    await expect(observer.start()).rejects.toThrow("不可安全使用");
    await expect(observer.input("unsafe")).rejects.toThrow("不可安全使用");
  });

  test("已建立的 observer 在 identity 被替换后也拒绝后续复核", async () => {
    const { identity } = await fixture();
    const observer = new TmuxTerminalObserver(identity);
    await observer.start();
    const overwritten = Bun.spawn(["tmux", "-S", identity.backendRef, "set-environment", "-t", identity.sessionName, "WF_NODE_ID", "other-node"], { stdout: "ignore", stderr: "pipe" });
    expect(await overwritten.exited).toBe(0);
    await expect(observer.verify()).rejects.toThrow("不可安全使用");
    await observer.close();
  });
});
