import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashValue } from "../src/journal/hash";
import { RunJournal, resolveRunDirectory } from "../src/journal/journal";
import type { RunManifest } from "../src/journal/types";
import { createWorkflowContext } from "../src/runtime/context";
import type { AgentAdapter } from "../src/adapters/agent-adapter";
import { MemoryEventSink } from "../src/events/memory-event-sink";
import { WorkflowRunner } from "../src/runtime/runner";
import { resumeRun } from "../src/cli/run-lifecycle";
import type { WorkflowModule } from "../src/workflow/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(runId: string, projectRoot: string): RunManifest {
  return { runId, workflowPath: join(projectRoot, "workflow.ts"), workflowHash: "a".repeat(64), input: { target: "src" }, adapter: "fake", cwd: projectRoot, createdAt: "2026-09-30T00:00:00.000Z" };
}

function runsRoot(projectRoot: string): string {
  return join(projectRoot, ".wave-flow", "runs");
}

const RUN_ONE = "11111111-1111-4111-8111-111111111111";
const RUN_TWO = "22222222-2222-4222-8222-222222222222";
const RUN_THREE = "33333333-3333-4333-8333-333333333333";

describe("RunJournal", () => {
  test("replays only completed nodes from the same run", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-journal-"));
    temporaryDirectories.push(root);
    const journal = await RunJournal.create(manifest(RUN_ONE, root), runsRoot(root));
    const inputHash = hashValue({ prompt: "Review src", schema: null, cwd: "/workspace", adapter: "fake" });
    await journal.append({ event: "agent.started", nodeKey: "review#1", inputHash, timestamp: "t1" });
    await journal.append({ event: "agent.completed", nodeKey: "review#1", inputHash, output: "Saved", timestamp: "t2" });
    await journal.append({ event: "agent.started", nodeKey: "review#2", inputHash, timestamp: "t3" });

    const restored = await RunJournal.open(RUN_ONE, runsRoot(root));
    expect(restored.completed("review#1", inputHash)).toBe("Saved");
    expect(restored.completed("review#2", inputHash)).toBeUndefined();
    expect(restored.completed("review#1", "different")).toBeUndefined();
  });

  test("replays a completed agent without invoking the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-replay-"));
    temporaryDirectories.push(root);
    const journal = await RunJournal.create(manifest(RUN_TWO, root), runsRoot(root));
    let calls = 0;
    const adapter: AgentAdapter = { execute: async () => ({ output: `Live ${++calls}` }) };
    const workflow: WorkflowModule = {
      meta: { name: "replay-check", description: "Check replay.", phases: ["review"], sideEffects: "none" },
      default: (ctx) => ctx.agent("Review src", { label: "review" }),
    };
    const first = new WorkflowRunner({ adapter, events: new MemoryEventSink(), cwd: root, runId: RUN_TWO, journal, adapterId: "fake" });
    await expect(first.run(workflow, undefined)).resolves.toMatchObject({ output: "Live 1", replayed: false });

    const restored = await RunJournal.open(RUN_TWO, runsRoot(root));
    const events = new MemoryEventSink();
    const second = new WorkflowRunner({ adapter, events, cwd: root, runId: RUN_TWO, journal: restored, adapterId: "fake" });
    await expect(second.run(workflow, undefined)).resolves.toMatchObject({ output: "Live 1", replayed: true });
    expect(calls).toBe(1);
    expect(events.events.map((event) => event.type)).toContain("agent.replayed");
  });

  test("rejects resume when the workflow source hash changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-hash-"));
    temporaryDirectories.push(root);
    const workflowPath = join(root, "workflow.ts");
    await writeFile(workflowPath, "export default async () => 'first';", "utf8");
    const workflowHash = hashValue(await readFile(workflowPath, "utf8"));
    const journal = await RunJournal.create({ ...manifest(RUN_THREE, root), workflowPath, workflowHash }, runsRoot(root));
    await writeFile(workflowPath, "export default async () => 'changed';", "utf8");
    const workflow: WorkflowModule = {
      meta: { name: "hash-check", description: "Check script hash.", phases: ["check"], sideEffects: "none" },
      default: async () => "unused",
    };

    await expect(resumeRun(journal.manifest)).rejects.toThrow("源码已变化");
  });

  test("ignores one truncated final journal line while preserving completed nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-torn-"));
    temporaryDirectories.push(root);
    const journal = await RunJournal.create(manifest(RUN_THREE, root), runsRoot(root));
    const inputHash = hashValue({ prompt: "Review src", schema: null, cwd: root, adapter: "fake" });
    await journal.append({ event: "agent.completed", nodeKey: "review#1", inputHash, output: "Saved", timestamp: "t1" });
    await writeFile(join(journal.directory, "journal.jsonl"), `${JSON.stringify({ event: "agent.completed", nodeKey: "review#1", inputHash, output: "Saved", timestamp: "t1" })}\n{"event":"agent.started"`, "utf8");

    const restored = await RunJournal.open(RUN_THREE, runsRoot(root));
    expect(restored.completed("review#1", inputHash)).toBe("Saved");
  });

  test("rejects a manifest that points outside the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-manifest-path-"));
    temporaryDirectories.push(root);
    const journalRoot = runsRoot(root);
    const outsidePath = join(tmpdir(), "outside-workflow.ts");
    await expect(RunJournal.create({ ...manifest(crypto.randomUUID(), root), workflowPath: outsidePath }, journalRoot)).rejects.toThrow(
      "workflowPath 必须位于当前项目内",
    );
  });

  test("rejects path traversal run ids and malformed manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-secure-"));
    temporaryDirectories.push(root);
    expect(() => resolveRunDirectory(root, "../../outside")).toThrow("无效的 runId");
    await expect(RunJournal.create({ ...manifest("not-a-uuid", root) }, runsRoot(root))).rejects.toThrow("无效的 runId");

    const runId = crypto.randomUUID();
    const directory = join(runsRoot(root), runId);
    await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ runId, workflowPath: "relative.ts" }), "utf8");
    await writeFile(join(directory, "journal.jsonl"), "", "utf8");
    await expect(RunJournal.open(runId, runsRoot(root))).rejects.toThrow("workflowPath 必须是绝对路径");
  });
});
