import { describe, expect, test } from "bun:test";
import { AgentStartLimiter, LimitedAgentExecutor } from "../../src/daemon/agent-start-limiter";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";

function node(id: string, sessionId: string | null = `${id}-session`): AgentNodeSnapshot {
  return { id, phase: "run", executionAttemptId: 1, phaseVisitId: 1, sequence: 1, executionBatch: { sequence: 1, mode: "serial" }, cli: "codex", sandbox: "workspace-write", cwd: "/tmp", label: id, status: sessionId ? "running" : "queued", result: null, diagnostic: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, agentSessionId: sessionId, block: null, request: { id, cli: "codex", sandbox: "workspace-write", cwd: "/tmp", prompt: id, phase: "run" } };
}

describe("AgentStartLimiter", () => {
  test("名额在前一 ACP Worker 结束前不启动后继节点", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const executor = new LimitedAgentExecutor({ async execute(current) { started.push(current.id); if (current.id === "first") await gate; return { id: current.id }; } }, new AgentStartLimiter(1));
    const first = node("first"); const second = node("second");
    await executor.waitForStart(first);
    const running = executor.execute(first);
    const waiting = executor.waitForStart(second);
    await Bun.sleep(5);
    expect(started).toEqual(["first"]);
    releaseFirst();
    await running; await waiting; await executor.execute(second);
    expect(started).toEqual(["first", "second"]);
  });

  test("释放名额时直接交给队首，后来请求不能插队", async () => {
    const limiter = new AgentStartLimiter(1);
    const first = await limiter.acquire();
    let secondRelease!: () => void;
    const second = limiter.acquire().then((release) => { secondRelease = release; });
    await Bun.sleep(1); first();
    const third = limiter.acquire();
    await second;
    let thirdReady = false; void third.then(() => { thirdReady = true; });
    await Bun.sleep(1); expect(thirdReady).toBe(false);
    secondRelease(); await third;
  });

  test("排队时没有 session id、执行时已有 id 仍能释放同一名额", async () => {
    const executor = new LimitedAgentExecutor({ execute: async (current) => ({ id: current.id }) }, new AgentStartLimiter(1));
    await executor.waitForStart(node("first", null));
    await executor.execute(node("first"));
    await expect(executor.waitForStart(node("second", null))).resolves.toBeUndefined();
    executor.cancelStart(node("second", null));
  });
});
