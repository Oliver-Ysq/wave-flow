import { describe, expect, test } from "bun:test";
import { MemoryEventSink } from "../src/events/memory-event-sink";
import { WorkflowRunner } from "../src/runtime/runner";
import { parseStructuredOutput } from "../src/runtime/schema";
import type { WorkflowModule } from "../src/workflow/types";

const readinessSchema = {
  type: "object",
  required: ["canProceed", "issues", "verification"],
  additionalProperties: false,
  properties: {
    canProceed: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    verification: {
      type: "object",
      required: ["status", "reason"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["passed", "failed", "not_run", "blocked_by_environment"] },
        reason: { type: "string" },
      },
    },
  },
};

describe("structured Agent output", () => {
  test("parses a valid JSON result that satisfies the schema", () => {
    expect(parseStructuredOutput<{
      canProceed: boolean;
      issues: string[];
      verification: { status: string; reason: string };
    }>(
      '{"canProceed":true,"issues":[],"verification":{"status":"passed","reason":"bun test passed"}}',
      readinessSchema,
    )).toEqual({ canProceed: true, issues: [], verification: { status: "passed", reason: "bun test passed" } });
  });

  test("accepts every explicit verification state", () => {
    for (const status of ["passed", "failed", "not_run", "blocked_by_environment"]) {
      expect(parseStructuredOutput(
        JSON.stringify({ canProceed: status !== "failed", issues: [], verification: { status, reason: "test" } }),
        readinessSchema,
      )).toMatchObject({ verification: { status } });
    }
  });

  test("rejects invalid JSON and schema-invalid values", () => {
    expect(() => parseStructuredOutput("not JSON", readinessSchema)).toThrow("不是合法 JSON");
    expect(() => parseStructuredOutput('{"canProceed":"yes","issues":[],"verification":{"status":"unknown","reason":"x"},"extra":true}', readinessSchema)).toThrow(
      "不满足 JSON Schema",
    );
  });

  test("turns a schema-invalid agent result into agent.failed and workflow.error", async () => {
    const events = new MemoryEventSink();
    const runner = new WorkflowRunner({
      adapter: { execute: async () => ({ output: '{"canProceed":"yes","issues":[],"verification":{"status":"unknown","reason":"x"}}' }) },
      events,
      cwd: "/workspace",
      runId: "run-schema-failed-001",
    });
    const workflow: WorkflowModule = {
      meta: { name: "schema-check", description: "Check structured output.", phases: ["check"], sideEffects: "none" },
      default: (ctx) => ctx.agent("Check readiness", { label: "readiness", schema: readinessSchema }),
    };

    await expect(runner.run(workflow, undefined)).rejects.toThrow("不满足 JSON Schema");
    expect(events.events.map((event) => event.type)).toEqual([
      "workflow.start",
      "agent.started",
      "agent.failed",
      "workflow.error",
    ]);
  });
});
