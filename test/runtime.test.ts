import { describe, expect, test } from "bun:test";
import { MemoryEventSink } from "../src/events";
import { WorkflowRuntime } from "../src/runtime";
import { FakeAgentAdapter } from "../src/testing/fake-agent-adapter";
import type { WorkflowModule } from "../src/types";

function createRuntime() {
  const adapter = new FakeAgentAdapter("No critical findings.");
  const events = new MemoryEventSink();
  const runtime = new WorkflowRuntime({
    adapter,
    events,
    cwd: "/workspace",
    runId: "run-test-001",
  });
  return { adapter, events, runtime };
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

describe("WorkflowRuntime", () => {
  test("delegates ctx.agent to the adapter and records lifecycle events", async () => {
    const { adapter, events, runtime } = createRuntime();

    const result = await runtime.run(workflow, { target: "src/auth" });

    expect(result).toEqual({
      output: "No critical findings.",
      replayed: false,
      runId: "run-test-001",
    });
    expect(adapter.calls).toEqual([
      { prompt: "Review target: src/auth", label: "initial-review", cwd: "/workspace" },
    ]);
    expect(events.events.map((event) => event.type)).toEqual([
      "workflow.start",
      "agent.started",
      "agent.completed",
      "workflow.end",
    ]);
    expect(events.events.every((event) => event.runId === "run-test-001")).toBe(true);
  });

  test("rejects an invalid meta object before starting an agent", async () => {
    const { adapter, events, runtime } = createRuntime();
    const invalidWorkflow = {
      ...workflow,
      meta: { ...workflow.meta, name: "Not kebab case" },
    } as WorkflowModule<{ target: string }>;

    await expect(runtime.run(invalidWorkflow, { target: "src/auth" })).rejects.toThrow(
      "Workflow meta.name must be kebab-case.",
    );
    expect(adapter.calls).toEqual([]);
    expect(events.events).toEqual([]);
  });

  test("rejects a workflow without a run entrypoint before starting an agent", async () => {
    const { adapter, events, runtime } = createRuntime();
    const invalidWorkflow = { meta: workflow.meta } as WorkflowModule<{ target: string }>;

    await expect(runtime.run(invalidWorkflow, { target: "src/auth" })).rejects.toThrow(
      "Workflow must export a default function or run function.",
    );
    expect(adapter.calls).toEqual([]);
    expect(events.events).toEqual([]);
  });
});
