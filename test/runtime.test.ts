import { describe, expect, test } from "bun:test";
import { FakeAgentAdapter } from "../src/adapters/testing/fake-agent-adapter";
import { MemoryEventSink } from "../src/events/memory-event-sink";
import { WorkflowRunner } from "../src/runtime/runner";
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
});
