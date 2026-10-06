import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, type CompletionSubmission } from "../../src/control/control-server";
import { RunJournal } from "../../src/journal/run-journal";
import { runsRoot } from "../../src/journal/paths";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { JsonSchema } from "../../src/shared/workflow-types";
import { TestExternalResultAdapter } from "../support/test-external-result-adapter";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("外部结果 Adapter 完成边界", () => {
  test("外部 JSON 结果只能经 CompletionSubmission 和 Control 完成节点", async () => {
    const value = await fixture();
    const adapter = new TestExternalResultAdapter(value.control);
    const submission: CompletionSubmission = {
      runId: value.runId,
      nodeId: "external-node",
      agentSessionId: value.agentSessionId,
      capability: value.capability,
      summary: "外部服务已返回结构化结果",
      result: { remoteId: "remote-42" },
    };

    await adapter.submitCompletion(submission);

    expect(value.state.agent("external-node")).toMatchObject({ status: "completed", result: { remoteId: "remote-42" } });
    const opened = await RunJournal.open(value.runId, value.storeRoot);
    const completed = opened.events.at(-1);
    expect(completed).toMatchObject({ type: "agent.completed", validationPath: expect.stringContaining("validation.json") });
  });

  test("外部 Adapter 的错误 capability 或 Schema 在写入任何完成证据前被拒绝", async () => {
    const value = await fixture({ type: "object", required: ["remoteId"], properties: { remoteId: { type: "string" } } });
    const adapter = new TestExternalResultAdapter(value.control);

    await expect(adapter.submitCompletion({
      runId: value.runId,
      nodeId: "external-node",
      agentSessionId: value.agentSessionId,
      capability: "wrong",
      summary: "bad capability",
      result: { remoteId: "remote-42" },
    })).rejects.toThrow("不匹配");

    await expect(adapter.submitCompletion({
      runId: value.runId,
      nodeId: "external-node",
      agentSessionId: value.agentSessionId,
      capability: value.capability,
      summary: "bad schema",
      result: {},
    })).rejects.toThrow("schema");

    expect(value.state.agent("external-node").status).toBe("running");
    const opened = await RunJournal.open(value.runId, value.storeRoot);
    expect(opened.events.some((event) => event.type === "agent.completed")).toBe(false);
  });
});

async function fixture(schema?: JsonSchema) {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-external-adapter-"));
  directories.push(cwd);
  const storeRoot = runsRoot(cwd);
  const manifest: RunManifest = {
    runId: crypto.randomUUID(),
    clientRequestId: crypto.randomUUID(),
    runtimeVersion: RUNTIME_VERSION,
    workflow: { name: "external-result", description: "Test external completion boundary.", phases: [{ title: "run" }] },
    workflowHash: "a".repeat(64),
    workflowPath: join(cwd, "workflow.ts"),
    workflowProjectCwd: cwd,
    input: {},
    createdAt: new Date().toISOString(),
  };
  const journal = await RunJournal.create(manifest, storeRoot);
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "external-node", cli: "codex" as const, cwd, sandbox: "read-only" as const, prompt: "external work", phase: "run", ...(schema ? { schema } : {}) };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "external-node", agentSessionId: null, diagnostic: null, sequence: 1, logicalSequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const agentSessionId = "external-session";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "external-node", agentSessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  const control = new ControlServer(journal, state);
  const capability = "external-capability";
  control.register({ runId: manifest.runId, nodeId: "external-node", agentSessionId, capability, reclaimTokenHash: "a".repeat(64) });
  await control.recordSession({
    runId: manifest.runId,
    nodeId: "external-node",
    agentSessionId,
    delivery: "tmux",
    session: { backend: "tmux", sessionName: "wf-external", backendRef: "/tmp/wf-external.sock", runId: manifest.runId, nodeId: "external-node", agentSessionId, cli: "codex", createdAt: new Date().toISOString() },
  });
  return { runId: manifest.runId, storeRoot, state, control, agentSessionId, capability };
}
