import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, type CompletionSubmission, type CompleteRequest } from "../../src/control/control-server";
import { RunJournal } from "../../src/journal/run-journal";
import { nodeDirectoryName, runsRoot } from "../../src/journal/paths";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { JsonSchema } from "../../src/shared/workflow-types";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture(schema?: JsonSchema) {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-control-")); directories.push(cwd);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "control-check", description: "Control check.", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, cwd, sandbox: "workspace-write" as const, prompt: "do work", phase: "run", ...(schema ? { schema } : {}) };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const agentSessionId = "session-1";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  const capability = "capability-1";
  const control = new ControlServer(journal, state);
  control.register({ runId: manifest.runId, nodeId: "node", agentSessionId, capability });
  await control.recordSession({
    runId: manifest.runId, nodeId: "node", agentSessionId, delivery: "tmux",
    session: { backend: "tmux", sessionName: "wf-control", backendRef: "/tmp/wf-control.sock", runId: manifest.runId, nodeId: "node", agentSessionId, cli: "codex", createdAt: new Date().toISOString() },
  });
  return { cwd, journal, state, control, runId: manifest.runId, agentSessionId, capability };
}

describe("ControlServer complete", () => {
  test("旧 CompleteRequest 导入保持为 CompletionSubmission 的兼容别名", () => {
    const submission: CompleteRequest = {
      runId: "run", nodeId: "node", agentSessionId: "session", capability: "capability", summary: "done", result: {},
    };
    const current: CompletionSubmission = submission;
    expect(current.summary).toBe("done");
  });

  test("校验身份后以结果、校验记录、Journal 的顺序完成节点", async () => {
    const value = await fixture({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } });
    await value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } });
    expect(value.state.agent("node")).toMatchObject({ status: "completed", result: { ok: true }, diagnostic: "done", agentSessionId: value.agentSessionId });
    const validation = JSON.parse(await readFile(join(value.journal.directory, "nodes", nodeDirectoryName("node"), "validation.json"), "utf8"));
    expect(validation).toMatchObject({ nodeId: "node", valid: true, result: { ok: true } });
    const reopened = await RunJournal.open(value.runId, runsRoot(value.cwd));
    expect(reopened.events.at(-1)).toMatchObject({ type: "agent.completed", diagnostic: "done", validationPath: expect.stringContaining("validation.json") });
  });

  test("非 Codex 的 Adapter 只能通过统一 CompletionSubmission 走 Control 完成", async () => {
    const value = await fixture({ type: "object", required: ["remoteId"], properties: { remoteId: { type: "string" } } });
    const submission: CompletionSubmission = {
      runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId,
      capability: value.capability, summary: "远端 Agent 已完成", result: { remoteId: "remote-42" },
    };
    await value.control.complete(submission);
    expect(value.state.agent("node")).toMatchObject({ status: "completed", result: { remoteId: "remote-42" } });
    const reopened = await RunJournal.open(value.runId, runsRoot(value.cwd));
    expect(reopened.events.at(-1)).toMatchObject({ type: "agent.completed", validationPath: expect.stringContaining("validation.json") });
  });

  test("Schema 或 capability 错误时保持 running，且不产生完成事件", async () => {
    const value = await fixture({ type: "object", required: ["ok"] });
    await expect(value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: {} })).rejects.toThrow("schema");
    await expect(value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: "wrong", summary: "done", result: { ok: true } })).rejects.toThrow("不匹配");
    expect(value.state.agent("node").status).toBe("running");
  });

  test("completed 后不允许再次 complete", async () => {
    const value = await fixture();
    const request = { runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } };
    await value.control.complete(request);
    await expect(value.control.complete(request)).rejects.toThrow("不匹配");
  });

  test("节点已 interrupted 后，旧受管会话不能将其复活为 completed", async () => {
    const value = await fixture();
    const interrupted: JournalEvent = {
      type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node",
      agentSessionId: value.agentSessionId, diagnostic: "会话不可验证", status: "interrupted",
    };
    await value.journal.append(interrupted); value.state.apply(interrupted);
    await expect(value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "late", result: { ok: true } })).rejects.toThrow("只允许当前 running 节点");
    expect(value.state.agent("node")).toMatchObject({ status: "interrupted", result: null });
  });

  test("首条任务会话坐标未耐久记录时拒绝 complete", async () => {
    const value = await fixture();
    const control = new ControlServer(value.journal, value.state);
    control.register({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability });
    await expect(control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } })).rejects.toThrow("会话坐标尚未耐久记录");
  });

  test("并发 complete 在任何结果或 Journal 写入前拒绝第二次上报", async () => {
    const value = await fixture();
    const request = { runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } };
    const first = value.control.complete(request);
    await expect(value.control.complete(request)).rejects.toThrow("拒绝并发上报");
    await first;
    const reopened = await RunJournal.open(value.runId, runsRoot(value.cwd));
    expect(reopened.events.filter((event) => event.type === "agent.completed")).toHaveLength(1);
  });

  test("Control 完成的 validation 记录丢失时，Journal 重开必须拒绝", async () => {
    const value = await fixture();
    await value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } });
    await unlink(join(value.journal.directory, "nodes", nodeDirectoryName("node"), "validation.json"));
    await expect(RunJournal.open(value.runId, runsRoot(value.cwd))).rejects.toThrow("校验记录不可读取");
  });

  test("Control 完成的 validation schema 被篡改时，Journal 重开必须拒绝", async () => {
    const value = await fixture({ type: "object", required: ["ok"] });
    await value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } });
    const path = join(value.journal.directory, "nodes", nodeDirectoryName("node"), "validation.json");
    const validation = JSON.parse(await readFile(path, "utf8"));
    validation.schema = { type: "string" };
    await writeFile(path, JSON.stringify(validation), "utf8");
    await expect(RunJournal.open(value.runId, runsRoot(value.cwd))).rejects.toThrow("schema 或结果不一致");
  });
});
