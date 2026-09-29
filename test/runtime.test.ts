import { describe, expect, test } from "bun:test";
import { FakeAgentAdapter } from "../src/adapters/testing/fake-agent-adapter";
import { MemoryEventSink } from "../src/events/memory-event-sink";
import { WorkflowRunner } from "../src/runtime/runner";
import type { AgentAdapter, AgentExecutionInput } from "../src/adapters/agent-adapter";
import type { WorkflowModule } from "../src/workflow/types";

function createRuntime() {
  // 每个测试使用新的依赖实例，避免其他测试的调用记录污染当前断言。
  const adapter = new FakeAgentAdapter("No critical findings.");
  const events = new MemoryEventSink();
  const runner = new WorkflowRunner({
    adapter,
    events,
    cwd: "/workspace",
    runId: "run-test-001",
  });
  return { adapter, events, runner };
}

const workflow: WorkflowModule<{ target: string }> = {
  meta: {
    name: "hello-review",
    description: "Review one target.",
    phases: ["review"],
    sideEffects: "none",
  },
  default: (ctx, args) => ctx.agent(`Review target: ${args.target}`, { label: "initial-review" }),
};

/**
 * 用测试手动控制每个 Agent 的完成时机。
 * 它让我们能证明 parallel 会在等待第一个结果前启动所有任务，也能验证屏障行为。
 */
class ControlledAgentAdapter implements AgentAdapter {
  readonly calls: AgentExecutionInput[] = [];
  private readonly pending = new Map<string, { resolve: (output: { output: string }) => void; reject: (error: Error) => void }>();

  execute(input: AgentExecutionInput): Promise<{ output: string }> {
    this.calls.push(input);
    return new Promise((resolve, reject) => this.pending.set(input.label, { resolve, reject }));
  }

  /** @param label 要完成的 Agent 节点。@param output 该节点的模拟最终输出。 */
  succeed(label: string, output: string): void {
    const operation = this.pending.get(label);
    if (!operation) throw new Error(`No pending agent named ${label}.`);
    operation.resolve({ output });
  }

  /** @param label 要失败的 Agent 节点。@param message 该节点抛出的错误信息。 */
  fail(label: string, message: string): void {
    const operation = this.pending.get(label);
    if (!operation) throw new Error(`No pending agent named ${label}.`);
    operation.reject(new Error(message));
  }
}

describe("WorkflowRunner", () => {
  test("delegates ctx.agent to the adapter and records lifecycle events", async () => {
    const { adapter, events, runner } = createRuntime();

    const result = await runner.run(workflow, { target: "src/auth" });

    // Workflow 获得 Adapter 输出，Runtime 统一补充 replayed 和 runId。
    expect(result).toEqual({
      output: "No critical findings.",
      replayed: false,
      runId: "run-test-001",
    });
    // 验证 Workflow 没有绕开 Runtime：prompt、label、cwd 都由 Runtime 传递给 Adapter。
    expect(adapter.calls).toEqual([
      { prompt: "Review target: src/auth", label: "initial-review", cwd: "/workspace" },
    ]);
    // 事件顺序是最小可观察性契约，未来 CLI 与 Journal 都将依赖它。
    expect(events.events.map((event) => event.type)).toEqual([
      "workflow.start",
      "agent.started",
      "agent.completed",
      "workflow.end",
    ]);
    expect(events.events.every((event) => event.runId === "run-test-001")).toBe(true);
  });

  test("rejects an invalid meta object before starting an agent", async () => {
    const { adapter, events, runner } = createRuntime();
    const invalidWorkflow = {
      ...workflow,
      meta: { ...workflow.meta, name: "Not kebab case" },
    } as WorkflowModule<{ target: string }>;

    // 非法 meta 必须在任何副作用之前失败，因此 Adapter 与事件均保持为空。
    await expect(runner.run(invalidWorkflow, { target: "src/auth" })).rejects.toThrow(
      "Workflow meta.name must be kebab-case.",
    );
    expect(adapter.calls).toEqual([]);
    expect(events.events).toEqual([]);
  });

  test("rejects a workflow without a run entrypoint before starting an agent", async () => {
    const { adapter, events, runner } = createRuntime();
    const invalidWorkflow = { meta: workflow.meta } as WorkflowModule<{ target: string }>;

    // 即使 meta 合法，缺少 default/run 入口的模块也不能启动 Agent。
    await expect(runner.run(invalidWorkflow, { target: "src/auth" })).rejects.toThrow(
      "Workflow must export a default function or run function.",
    );
    expect(adapter.calls).toEqual([]);
    expect(events.events).toEqual([]);
  });

  test("starts parallel tasks together, preserves input order, and waits at the barrier", async () => {
    const adapter = new ControlledAgentAdapter();
    const events = new MemoryEventSink();
    const runner = new WorkflowRunner({ adapter, events, cwd: "/workspace", runId: "run-parallel-001" });
    let synthesisStarted = false;
    const parallelWorkflow: WorkflowModule = {
      meta: { name: "parallel-review", description: "Run independent reviews.", phases: ["review"], sideEffects: "none" },
      default: async (ctx) => {
        const reviews = await ctx.parallel([
          () => ctx.agent("Security review", { label: "security" }),
          () => ctx.agent("Correctness review", { label: "correctness" }),
          () => ctx.agent("Maintainability review", { label: "maintainability" }),
        ]);
        synthesisStarted = true;
        return reviews;
      },
    };

    const running = runner.run(parallelWorkflow, undefined);
    await Promise.resolve();
    await Promise.resolve();

    // 三项必须在任意一项完成前都已开始；否则实现实际是串行的。
    expect(adapter.calls.map((call) => call.label)).toEqual(["security", "correctness", "maintainability"]);
    expect(synthesisStarted).toBe(false);

    // 故意以不同于输入的顺序完成，验证结果仍回到对应的输入位置。
    adapter.succeed("maintainability", "Maintainable.");
    adapter.succeed("security", "Secure.");
    await Promise.resolve();
    expect(synthesisStarted).toBe(false);
    adapter.succeed("correctness", "Correct.");

    await expect(running).resolves.toEqual([
      { output: "Secure.", replayed: false, runId: "run-parallel-001" },
      { output: "Correct.", replayed: false, runId: "run-parallel-001" },
      { output: "Maintainable.", replayed: false, runId: "run-parallel-001" },
    ]);
    expect(synthesisStarted).toBe(true);
  });

  test("turns one parallel failure into null without cancelling successful siblings", async () => {
    const adapter = new ControlledAgentAdapter();
    const events = new MemoryEventSink();
    const runner = new WorkflowRunner({ adapter, events, cwd: "/workspace", runId: "run-parallel-002" });
    const parallelWorkflow: WorkflowModule = {
      meta: { name: "failure-isolation", description: "Isolate independent failures.", phases: ["review"], sideEffects: "none" },
      default: (ctx) => ctx.parallel([
        () => ctx.agent("Pass", { label: "pass" }),
        () => ctx.agent("Fail", { label: "fail" }),
        () => ctx.agent("Also pass", { label: "also-pass" }),
      ]),
    };

    const running = runner.run(parallelWorkflow, undefined);
    await Promise.resolve();
    await Promise.resolve();
    adapter.fail("fail", "Agent unavailable.");
    adapter.succeed("also-pass", "Second result.");
    adapter.succeed("pass", "First result.");

    await expect(running).resolves.toEqual([
      { output: "First result.", replayed: false, runId: "run-parallel-002" },
      null,
      { output: "Second result.", replayed: false, runId: "run-parallel-002" },
    ]);
    expect(events.events.filter((event) => event.type === "agent.completed")).toHaveLength(2);
  });
});
