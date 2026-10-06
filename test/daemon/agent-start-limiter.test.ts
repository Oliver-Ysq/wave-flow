import { describe, expect, test } from "bun:test";
import { AgentStartLimiter, LimitedAgentExecutor } from "../../src/daemon/agent-start-limiter";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";

function node(id: string): AgentNodeSnapshot {
  return {
    id, phase: "run", executionAttemptId: 1, phaseVisitId: 1, sequence: 1, executionBatch: { sequence: 1, mode: "serial" }, cli: "codex", sandbox: "read-only", cwd: "/tmp", label: id,
    status: "running", result: null, diagnostic: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
    agentSessionId: `${id}-session`, block: null, request: { id, cli: "codex", cwd: "/tmp", sandbox: "read-only", prompt: id, phase: "run" },
  };
}

describe("AgentStartLimiter", () => {
  test("第二个 Agent 在第一个结束前不进入执行器，从而限制真实会话和 App Server", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const executor = new LimitedAgentExecutor({
      async execute(current) {
        started.push(current.id);
        if (current.id === "first") await firstGate;
        return { id: current.id };
      },
    }, new AgentStartLimiter(1));
    const first = node("first");
    const second = node("second");
    await executor.waitForStart!(first);
    const firstExecution = executor.execute(first);
    const waitingSecond = executor.waitForStart!(second);
    await Bun.sleep(10);
    expect(started).toEqual(["first"]);
    let secondStarted = false;
    void waitingSecond.then(() => { secondStarted = true; });
    expect(secondStarted).toBe(false);
    releaseFirst?.();
    await firstExecution;
    await waitingSecond;
    await executor.execute(second);
    expect(started).toEqual(["first", "second"]);
  });

  test("节点在 execute 前取消启动时归还名额", async () => {
    const executor = new LimitedAgentExecutor({ execute: async (current) => ({ id: current.id }) }, new AgentStartLimiter(1));
    const first = node("first");
    const second = node("second");
    await executor.waitForStart!(first);
    executor.cancelStart!(first);
    await expect(executor.waitForStart!(second)).resolves.toBeUndefined();
    executor.cancelStart!(second);
  });

  test("释放名额时直接转交给等待者，新请求不能插队突破上限", async () => {
    const limiter = new AgentStartLimiter(1);
    const first = await limiter.acquire();
    let secondRelease: (() => void) | undefined;
    const second = limiter.acquire().then((release) => { secondRelease = release; });
    await Bun.sleep(1);
    first();
    const third = limiter.acquire();
    await Bun.sleep(1);
    expect(secondRelease).toBeDefined();
    let thirdResolved = false;
    void third.then(() => { thirdResolved = true; });
    await Bun.sleep(1);
    expect(thirdResolved).toBe(false);
    secondRelease?.();
    await second;
    await third;
  });

  test("申请时没有 sessionId、执行时已有 sessionId，仍能正确释放同一名额", async () => {
    const limiter = new AgentStartLimiter(1);
    const executor = new LimitedAgentExecutor({ execute: async (current) => ({ id: current.id }) }, limiter);
    const queued = { ...node("first"), status: "queued" as const, agentSessionId: null };
    await executor.waitForStart!(queued);
    await executor.execute(node("first"));
    const second = { ...node("second"), status: "queued" as const, agentSessionId: null };
    await expect(executor.waitForStart!(second)).resolves.toBeUndefined();
    executor.cancelStart!(second);
  });

  test("pause、recover、stop 与 viewer 坐标透明转发给真实执行器", async () => {
    const node = { id: "node", agentSessionId: "session" } as AgentNodeSnapshot;
    const calls: string[] = [];
    const identity = { sessionName: "viewer" } as import("../../src/sessions/types").SessionIdentity;
    const limited = new LimitedAgentExecutor({
      execute: async () => ({}),
      pause: async () => { calls.push("pause"); },
      recover: async () => { calls.push("recover"); return {}; },
      stop: async () => { calls.push("stop"); },
      viewerSession: () => identity,
    }, new AgentStartLimiter(1));
    await limited.pause(node);
    await limited.recover(node);
    await limited.stop(node);
    expect(calls).toEqual(["pause", "recover", "stop"]);
    expect(limited.viewerSession(node)).toBe(identity);
  });
});
