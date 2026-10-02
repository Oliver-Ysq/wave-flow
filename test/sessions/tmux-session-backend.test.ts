import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { privateTmuxSocketPath, TmuxCommandClient } from "../../src/sessions/backends/tmux-command";
import { TmuxSessionBackend } from "../../src/sessions/backends/tmux-session-backend";
import type { SessionIdentity } from "../../src/sessions/types";
import type { TmuxCommandRunner } from "../../src/sessions/backends/tmux-command";

const directories: string[] = [];
const sessions: Array<{ backend: TmuxSessionBackend; identity: SessionIdentity; client: TmuxCommandClient }> = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async ({ backend, identity, client }) => {
    await backend.destroy(identity).catch(() => undefined);
    await client.closePrivateServer().catch(() => undefined);
  }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createBackend() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-tmux-"));
  directories.push(cwd);
  const socket = privateTmuxSocketPath(join(cwd, ".wave-flow", "runtime"), "test");
  const identityFile = join(cwd, ".wave-flow", "runs", "test", "nodes", "node", "session.json");
  const client = new TmuxCommandClient(socket);
  const backend = new TmuxSessionBackend(client, 50, 2_000);
  const identity = await backend.create({
    runId: "11111111-1111-4111-8111-111111111111",
    nodeId: "node-visible-but-not-in-name",
    cli: "codex",
    cwd,
    command: ["/bin/sh", "-c", "while IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done"],
    identityFile,
  });
  sessions.push({ backend, identity, client });
  return { socket, identityFile, backend, identity };
}

describe("TmuxSessionBackend", () => {
  test("在私有 socket 创建、写入、读取并销毁会话，不污染默认 tmux server", async () => {
    const { socket, identityFile, backend, identity } = await createBackend();
    expect(identity.sessionName).toStartWith("wf-11111111-");
    expect(identity.sessionName).not.toContain("node-visible-but-not-in-name");
    expect(identity.backendRef).toBe(socket);
    expect((await stat(dirname(socket))).mode & 0o777).toBe(0o700);
    await expect(backend.liveness(identity)).resolves.toBe("exists");
    await expect(readFile(identityFile, "utf8")).resolves.toContain(identity.agentSessionId);
    expect((await stat(identityFile)).mode & 0o777).toBe(0o600);
    await backend.sendText(identity, "hello tmux\n");
    await Bun.sleep(100);
    await expect(backend.readRecent(identity)).resolves.toContain("ECHO:hello tmux");
    const defaultSessions = await Bun.$`tmux list-sessions`.text();
    expect(defaultSessions).not.toContain(identity.sessionName);
    const result = await backend.destroy(identity);
    expect(result).toEqual({ status: "destroyed", diagnostic: null });
    await expect(backend.liveness(identity)).resolves.toBe("missing");
    await expect(access(identityFile)).rejects.toThrow();
  });

  test("identity 被篡改时拒绝读写和销毁", async () => {
    const { backend, identity } = await createBackend();
    const forged = { ...identity, agentSessionId: crypto.randomUUID() };
    await expect(backend.liveness(forged)).resolves.toBe("unknown");
    await expect(backend.sendText(forged, "unsafe")).rejects.toThrow("unknown");
    await expect(backend.destroy(forged)).resolves.toMatchObject({ status: "termination-unconfirmed" });
    await expect(backend.liveness(identity)).resolves.toBe("exists");
    await expect(backend.liveness({ ...identity, backendRef: "/tmp/other-socket" })).resolves.toBe("unknown");
  });

  test("liveness unknown 时 destroy 不发送中断或删除 identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-tmux-")); directories.push(cwd);
    const identityFile = join(cwd, "session.json");
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = { run: async (args) => { calls.push([...args]); throw new Error("socket timeout"); } };
    const backend = new TmuxSessionBackend(new TmuxCommandClient(join(cwd, "socket"), runner), 1, 5);
    const identity: SessionIdentity = { backend: "tmux", sessionName: "wf-test", backendRef: join(cwd, "socket"), runId: "run", nodeId: "node", agentSessionId: "agent", cli: "codex", createdAt: new Date().toISOString(), identityFile };
    await writeFile(identityFile, JSON.stringify(identity), "utf8");
    await expect(backend.destroy(identity)).resolves.toMatchObject({ status: "termination-unconfirmed" });
    expect(calls.some((args) => args.includes("send-keys") || args.includes("kill-session"))).toBe(false);
    await expect(readFile(identityFile, "utf8")).resolves.toContain("wf-test");
  });
});
