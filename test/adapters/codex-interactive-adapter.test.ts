import { afterEach, describe, expect, test } from "bun:test";
import { CodexInteractiveAdapter } from "../../src/adapters/codex-interactive-adapter";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { SessionIdentity } from "../../src/sessions/types";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxCommandClient, privateTmuxSocketPath } from "../../src/sessions/backends/tmux-command";
import { TmuxSessionBackend } from "../../src/sessions/backends/tmux-session-backend";
import { InteractiveCliBootstrap } from "../../src/sessions/bootstrap/interactive-cli-bootstrap";

const directories: string[] = [];
const liveSessions: Array<{ readonly backend: TmuxSessionBackend; readonly identity: SessionIdentity; readonly client: TmuxCommandClient }> = [];
afterEach(async () => {
  await Promise.all(liveSessions.splice(0).map(async ({ backend, identity, client }) => {
    await backend.destroy(identity).catch(() => undefined);
    await client.closePrivateServer().catch(() => undefined);
  }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function node(overrides: Partial<AgentNodeSnapshot> = {}): AgentNodeSnapshot {
  return {
    id: "review", phase: "scan", sequence: 1, cli: "codex", sandbox: "read-only", cwd: "/workspace/project", label: "Review", status: "running", result: null, diagnostic: null,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, agentSessionId: null,
    request: { id: "review", cli: "codex", cwd: "/workspace/project", sandbox: "read-only", prompt: "检查变更", phase: "scan" },
    ...overrides,
  };
}

describe("CodexInteractiveAdapter", () => {
  test("只构造正常交互式 codex argv，并将 Prompt 作为位置参数", () => {
    const adapter = new CodexInteractiveAdapter("codex-test");
    expect(adapter.commandFor({ node: node({ sandbox: "workspace-write", request: { ...node().request, model: "gpt-test" } }), prompt: "修复 '引号'\n并检查" })).toEqual([
      "codex-test", "--sandbox", "workspace-write", "--cd", "/workspace/project", "--no-alt-screen", "--model", "gpt-test", "修复 '引号'\n并检查",
    ]);
  });

  test("首条 Prompt 只经启动 argv 交给 Bootstrap，不通过 Adapter 的 shell 或 tmux paste", async () => {
    const adapter = new CodexInteractiveAdapter();
    const plan = adapter.launch({ runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/.wave-flow/session.json" });
    expect(plan.command).toEqual(["codex", "--sandbox", "read-only", "--cd", "/workspace/project", "--no-alt-screen", "检查变更"]);
    await expect(adapter.submitInitialPrompt({ runId: "11111111-1111-4111-8111-111111111111", node: node(), prompt: "检查变更", identityFile: "/workspace/project/.wave-flow/session.json" }, {} as never)).resolves.toBeUndefined();
  });

  test("拒绝非 Codex 节点和空 Prompt", () => {
    const adapter = new CodexInteractiveAdapter();
    expect(() => adapter.commandFor({ node: node({ cli: "claude" }), prompt: "任务" })).toThrow("cli: codex");
    expect(() => adapter.commandFor({ node: node(), prompt: " " })).toThrow("非空");
  });

  test("通过真实私有 tmux 将受控 argv 交给正常交互进程", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-codex-adapter-"));
    directories.push(cwd);
    const received = join(cwd, "received-argv");
    const fakeCodex = join(cwd, "fake-codex");
    await writeFile(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$@" > '${received}'\nwhile :; do sleep 1; done\n`, "utf8");
    await chmod(fakeCodex, 0o700);
    const client = new TmuxCommandClient(privateTmuxSocketPath(join(cwd, "runtime"), "adapter-test"));
    const backend = new TmuxSessionBackend(client, 20, 1_000);
    const adapter = new CodexInteractiveAdapter(fakeCodex);
    const request = {
      runId: "11111111-1111-4111-8111-111111111111",
      node: node({ cwd, sandbox: "workspace-write" }),
      prompt: "检查交互启动",
      identityFile: join(cwd, "session.json"),
    } as const;
    const plan = adapter.launch(request);
    const identity = await backend.create({ runId: request.runId, nodeId: request.node.id, cli: "codex", cwd, command: plan.command, identityFile: request.identityFile });
    liveSessions.push({ backend, identity, client });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await readFile(received, "utf8")).includes("检查交互启动")) break; } catch {}
      await Bun.sleep(25);
    }
    await expect(readFile(received, "utf8")).resolves.toBe(`--sandbox\nworkspace-write\n--cd\n${cwd}\n--no-alt-screen\n检查交互启动\n`);
    expect(await backend.liveness(identity)).toBe("exists");
  });
});
