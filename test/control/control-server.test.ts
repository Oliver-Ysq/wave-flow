import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, type CompletionSubmission } from "../../src/control/control-server";
import { RunJournal } from "../../src/journal/run-journal";
import { runsRoot } from "../../src/journal/paths";
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
    runId: manifest.runId, nodeId: "node", agentSessionId, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "control", capabilities: {} },
  });
  return { cwd, journal, state, control, runId: manifest.runId, agentSessionId, capability };
}

describe("ControlServer complete", () => {
  test("收尾快照验证原身份、返回副本，终态拒绝且不写入",async()=>{
    const value=await fixture({type:"object",properties:{ok:{type:"boolean"}}});
    const identity={runId:value.runId,nodeId:"node",agentSessionId:value.agentSessionId,capability:value.capability};
    const before=(await RunJournal.open(value.runId,runsRoot(value.cwd))).events.length;
    await expect(value.control.workerTurnContext({...identity,capability:"wrong"})).rejects.toThrow("capability");
    const snapshot=await value.control.workerTurnContext(identity);expect(snapshot.status).toBe("running");expect(snapshot.block).toBeNull();
    (snapshot.resultSchema as any).properties.ok.type="string";
    expect((await value.control.workerTurnContext(identity)).resultSchema).toEqual({type:"object",properties:{ok:{type:"boolean"}}});
    expect((await RunJournal.open(value.runId,runsRoot(value.cwd))).events.length).toBe(before);
    await value.control.complete({...identity,summary:"done",result:{ok:true}});
    await expect(value.control.workerTurnContext(identity)).rejects.toThrow();
  });
  test("校验身份后以结果、校验记录、Journal 的顺序完成节点", async () => {
    const value = await fixture({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } });
    await value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } });
    expect(value.state.agent("node")).toMatchObject({ status: "completed", result: { ok: true }, diagnostic: "done", agentSessionId: value.agentSessionId });
    const completed = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events.at(-1)! as Extract<JournalEvent, { type: "agent.completed" }>;
    const validation = JSON.parse(await readFile(join(value.journal.directory, completed.validationPath!), "utf8"));
    expect(validation).toMatchObject({ nodeId: "node", valid: true, result: { ok: true } });
    const reopened = await RunJournal.open(value.runId, runsRoot(value.cwd));
    expect(reopened.events.at(-1)).toMatchObject({ type: "agent.completed", diagnostic: "done", validationPath: expect.stringContaining("validation.json") });
  });

  test("恢复 prompt 后的快速 complete 等待 recovered/running 落盘再受理", async () => {
    const value = await fixture();
    for (const status of ["pausing", "paused", "recovering"] as const) {
      const event: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, status, pauseCause: "recovery" };
      await value.journal.append(event);
      value.state.apply(event);
    }
    const completing = value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } });
    let settled = false;
    void completing.then(() => { settled = true; }, () => { settled = true; });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    const recovered: JournalEvent = { type: "agent.recovered", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, acp: { launcherId: "codex-acp", sessionId: "control" } };
    await value.journal.append(recovered);
    value.state.apply(recovered);
    const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, status: "running" };
    await value.journal.append(running);
    value.state.apply(running);
    await completing;
    expect(value.state.agent("node").status).toBe("completed");
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
    const completed = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events.at(-1)! as Extract<JournalEvent, { type: "agent.completed" }>;
    await unlink(join(value.journal.directory, completed.validationPath!));
    await expect(RunJournal.open(value.runId, runsRoot(value.cwd))).rejects.toThrow("校验记录不可读取");
  });

  test("Control 完成的 validation schema 被篡改时，Journal 重开必须拒绝", async () => {
    const value = await fixture({ type: "object", required: ["ok"] });
    await value.control.complete({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, summary: "done", result: { ok: true } });
    const completed = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events.at(-1)! as Extract<JournalEvent, { type: "agent.completed" }>;
    const path = join(value.journal.directory, completed.validationPath!);
    const validation = JSON.parse(await readFile(path, "utf8"));
    validation.schema = { type: "string" };
    await writeFile(path, JSON.stringify(validation), "utf8");
    await expect(RunJournal.open(value.runId, runsRoot(value.cwd))).rejects.toThrow("schema 或结果不一致");
  });
});

describe("ControlServer block / answer / continue", () => {
  test("显式非对象answerSchema在任何block事实写入前拒绝", async () => {
    const value = await fixture();
    const before = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events.length;
    await expect(value.control.block({ blockRequestId: crypto.randomUUID(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "请输入数字", answerSchema: { type: "integer", const: 6 } })).rejects.toThrow("根 type 必须是 object");
    expect(value.state.agent("node").status).toBe("running");
    expect((await RunJournal.open(value.runId, runsRoot(value.cwd))).events).toHaveLength(before);
  });
  test("答案先耐久落盘并只唤醒原 block；continue 才恢复 running", async () => {
    const value = await fixture({ type: "object", required: ["resolved"], properties: { resolved: { type: "boolean" } } });
    const blockRequestId = crypto.randomUUID();
    const submission = {
      blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability,
      needHelp: "测试数据库不可连接，请人工处理。", answerSchema: { type: "object", required: ["resolved"], properties: { resolved: { type: "boolean" } } },
    };
    await value.control.block(submission);
    await waitFor(() => value.state.agent("node").status === "blocked");
    expect(value.state.agent("node")).toMatchObject({ status: "blocked", block: { blockRequestId, answered: false } });
    await expect(value.control.continue({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability })).rejects.toThrow("尚未收到");
    await value.control.answer({ blockRequestId, answer: { resolved: true } });
    const resolution = await value.control.block(submission);
    expect(resolution).toMatchObject({ blockRequestId, answer: { resolved: true } });
    expect(value.state.agent("node")).toMatchObject({ status: "blocked", block: { blockRequestId, answered: true } });
    const events = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["block.created", "block.answered"]));
    await value.control.continue({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability });
    expect(value.state.agent("node")).toMatchObject({ status: "running", block: null });
  });

  test("错误答案和错误会话拒绝；同答案幂等、冲突答案拒绝覆盖", async () => {
    const value = await fixture({ type: "object", required: ["resolved"], properties: { resolved: { type: "boolean" } } });
    const blockRequestId = crypto.randomUUID();
    const waiting = value.control.block({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要帮助", answerSchema: { type: "object", required: ["resolved"], properties: { resolved: { type: "boolean" } } } });
    await waitFor(() => value.state.agent("node").status === "blocked");
    expect(value.state.snapshot().phases[0].agents[0].block?.answerSchema).toMatchObject({type:"object",required:["resolved"]});
    await expect(value.control.answer({ blockRequestId, answer: {} })).rejects.toThrow("answer-schema");
    await expect(value.control.continue({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: "foreign", capability: value.capability })).rejects.toThrow("不匹配");
    await value.control.answer({ blockRequestId, answer: { resolved: true } });
    await value.control.answer({ blockRequestId, answer: { resolved: true } });
    await expect(value.control.answer({ blockRequestId, answer: { resolved: false } })).rejects.toThrow("不同答案");
    await waiting;
  });

  test("并发 answer 只允许一个耐久答案事实", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const waiting = value.control.block({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要帮助", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } });
    await waitFor(() => value.state.agent("node").status === "blocked");
    const first = value.control.answer({ blockRequestId, answer: { ok: true } });
    await expect(value.control.answer({ blockRequestId, answer: { ok: true } })).rejects.toThrow("拒绝并发 answer");
    await first; await waiting;
    const events = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events;
    expect(events.filter((event) => event.type === "block.answered")).toHaveLength(1);
  });

  test("已 blocked 的原会话不能追加第二个 block 事实", async () => {
    const value = await fixture();
    const firstId = crypto.randomUUID();
    const waiting = value.control.block({ blockRequestId: firstId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "第一次求助", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } });
    await waitFor(() => value.state.agent("node").status === "blocked");
    await expect(value.control.block({ blockRequestId: crypto.randomUUID(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "第二次求助", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } })).rejects.toThrow("只允许当前 running");
    const events = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events;
    expect(events.filter((event) => event.type === "block.created")).toHaveLength(1);
    await value.control.answer({ blockRequestId: firstId, answer: {} });
    await waiting;
  });

  test("会话注销会拒绝 Elicitation 等待者并清理 pending", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要帮助", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
    await value.control.block(submission);
    const waiting = value.control.waitForBlockAnswer(submission, { mode: "form", message: submission.needHelp, requestedSchema: submission.answerSchema });
    await waitFor(() => value.state.agent("node").status === "blocked");
    value.control.unregister(value.runId, "node", value.agentSessionId);
    await expect(waiting).rejects.toThrow("会话已结束");
    expect(value.control.hasBlock(blockRequestId)).toBe(false);
  });

  test("同一 blockRequestId 的重连不写新 Journal 事实，答案交付给所有等待者", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要整数 x", answerSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] } };
    await value.control.block(submission);
    await waitFor(() => value.state.agent("node").status === "blocked");
    await value.control.block(submission);
    const events = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events;
    expect(events.filter((event) => event.type === "block.created")).toHaveLength(1);
    await value.control.answer({ blockRequestId, answer: { x: 7 } });
    await expect(value.control.block(submission)).resolves.toMatchObject({ blockRequestId, answer: { x: 7 } });
    await expect(value.control.block(submission)).resolves.toMatchObject({ blockRequestId, answer: { x: 7 } });
    // 答案已交付后的重接立即返回同一答案，用于答案与表单关闭竞争的边界。
    await expect(value.control.block(submission)).resolves.toMatchObject({ blockRequestId, answer: { x: 7 } });
    expect((await RunJournal.open(value.runId, runsRoot(value.cwd))).events.filter((event) => event.type === "block.created")).toHaveLength(1);
    await value.control.continue({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability });
    expect(value.state.agent("node").status).toBe("running");
  });

  test("重接 block 的内容或身份不一致拒绝；continue 后原答案仍可幂等读取", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const base = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要整数 x", answerSchema: { type: "object", properties: { x: { type: "integer" } } } };
    await value.control.block(base);
    await waitFor(() => value.state.agent("node").status === "blocked");
    await expect(value.control.block({ ...base, needHelp: "换一个问题" })).rejects.toThrow("不一致");
    await expect(value.control.block({ ...base, answerSchema: { type: "object", properties: { y: { type: "integer" } } } })).rejects.toThrow("不一致");
    await expect(value.control.block({ ...base, agentSessionId: "foreign" })).rejects.toThrow("不匹配");
    await value.control.answer({ blockRequestId, answer: { x: 9 } });
    await value.control.continue({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability });
    expect(value.control.hasBlock(blockRequestId)).toBe(true);
    await expect(value.control.block(base)).resolves.toMatchObject({ blockRequestId, answer: { x: 9 } });
    await value.control.continue({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability });
    await expect(value.control.answer({ blockRequestId, answer: { x: 9 } })).resolves.toBeUndefined();
    await expect(value.control.answer({ blockRequestId, answer: { x: 10 } })).rejects.toThrow("不同答案");
    const events = await RunJournal.open(value.runId, runsRoot(value.cwd));
    expect(events.events.filter(event => event.type === "block.created")).toHaveLength(1);
    expect(events.events.filter(event => event.type === "block.answered")).toHaveLength(1);
    expect(events.events.filter(event => event.type === "agent.continued")).toHaveLength(1);
  });
  test("关闭 elicitation 后 Worker 重接不能撤销关闭或接受迟到答案", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
    await value.control.block(submission);
    const controller = new AbortController();
    const waiting = value.control.waitForBlockAnswer(submission, { mode: "form", message: submission.needHelp, requestedSchema: submission.answerSchema }, controller.signal);
    controller.abort();
    expect(await waiting).toEqual({ action: "cancel" });
    expect(value.state.agent("node").block?.delivery).toBe("closed");
    await expect(value.control.block(submission)).resolves.toMatchObject({ delivery: "closed", answer: null });
    expect(value.state.agent("node").block?.delivery).toBe("closed");
    await expect(value.control.answer({ blockRequestId, answer: { ok: true } })).rejects.toThrow("已关闭");
    const events = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events;
    expect(events.filter(event => event.type === "block.closed")).toHaveLength(1);
    expect(events.filter(event => event.type === "block.reopened")).toHaveLength(0);
    expect(events.filter(event => event.type === "block.created")).toHaveLength(1);
  });

  test("Worker close-block 复核原会话，跨节点关闭在 Journal 写入前拒绝", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
    await value.control.block(submission);
    await expect(value.control.closeBlock(blockRequestId, { ...submission, agentSessionId: "foreign" })).rejects.toThrow("身份不匹配");
    expect(value.state.agent("node").block?.delivery).toBe("pending");
    await value.control.closeBlock(blockRequestId, submission);
    expect(value.state.agent("node").block?.delivery).toBe("closed");
    expect((await RunJournal.open(value.runId, runsRoot(value.cwd))).events.filter(event => event.type === "block.closed")).toHaveLength(1);
  });

  test("暂停/恢复期间答案可耐久，恢复后 continue；暂停关闭立即释放等待者", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
    await value.control.block(submission);
    const waiting = value.control.waitForBlockAnswer(submission, { mode: "form", message: submission.needHelp, requestedSchema: submission.answerSchema });
    for (const status of ["pausing", "paused", "recovering"] as const) {
      const event: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, status };
      await value.journal.append(event);
      value.state.apply(event);
    }
    await value.control.answer({ blockRequestId, answer: { ok: true } });
    expect(await waiting).toEqual({ action: "accept", content: { ok: true } });
    const recovered: JournalEvent = { type: "agent.recovered", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, acp: { launcherId: "codex-acp", sessionId: "control" } };
    await value.journal.append(recovered);
    value.state.apply(recovered);
    const blocked: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, status: "blocked" };
    await value.journal.append(blocked);
    value.state.apply(blocked);
    await value.control.continue(submission);
    expect(value.state.agent("node").status).toBe("running");
  });

  test("暂停中 closeBlock 取消等待者但不伪造 closed 事件", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
    await value.control.block(submission);
    const waiting = value.control.waitForBlockAnswer(submission, { mode: "form", message: submission.needHelp, requestedSchema: submission.answerSchema });
    const pausing: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, status: "pausing" };
    await value.journal.append(pausing);
    value.state.apply(pausing);
    await value.control.closeBlock(blockRequestId);
    expect(await waiting).toEqual({ action: "cancel" });
    expect((await RunJournal.open(value.runId, runsRoot(value.cwd))).events.filter(event => event.type === "block.closed")).toHaveLength(0);
  });

  test("关闭先于 Elicitation 注册时立即 cancel，不留下 24 小时等待者", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
    await value.control.block(submission);
    await value.control.closeBlock(blockRequestId);
    const waiting = value.control.waitForBlockAnswer(submission, { mode: "form", message: submission.needHelp, requestedSchema: submission.answerSchema });
    expect(await Promise.race([waiting, Bun.sleep(50).then(() => "timeout")])).toEqual({ action: "cancel" });
    expect((await RunJournal.open(value.runId, runsRoot(value.cwd))).events.filter(event => event.type === "block.closed")).toHaveLength(1);
  });
});

describe("ControlServer rebind", () => {
  test("同一 attempt 内换 capability：旧凭据立即失效，新凭据可完成", async () => {
    const value = await fixture();
    const next = "capability-2";
    value.control.rebind({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: next });
    await expect(value.control.complete({
      runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId,
      capability: value.capability, summary: "old", result: { ok: true },
    })).rejects.toThrow();
    await value.control.complete({
      runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId,
      capability: next, summary: "done", result: { ok: true },
    });
    expect(value.state.agent("node").status).toBe("completed");
  });

  test("rebind 不接受未注册节点或相同 capability", async () => {
    const value = await fixture();
    expect(() => value.control.rebind({ runId: value.runId, nodeId: "missing", agentSessionId: value.agentSessionId, capability: "x" })).toThrow("尚未注册");
    expect(() => value.control.rebind({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability })).toThrow("新的 capability");
  });

  test("recovering 状态允许 rebind 与 recordWriter（用户恢复重建路径）", async () => {
    const value = await fixture();
    for (const status of ["pausing", "paused", "recovering"] as const) {
      value.state.apply({ type: "agent.status", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, status, pauseCause: "recovery" });
    }
    value.control.rebind({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: "capability-2" });
    await value.control.recordWriter({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, pgid: 4242, startedAt: "fp-2" });
    expect(value.state.agent("node").writer).toEqual({ pgid: 4242, startedAt: "fp-2" });
  });
});

describe("ControlServer writer evidence", () => {
  test("同一 attempt 内可覆盖 provider 进程组证据", async () => {
    const value = await fixture();
    await value.control.recordWriter({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, pgid: 4242, startedAt: "fp-1" });
    expect(value.state.agent("node").writer).toEqual({ pgid: 4242, startedAt: "fp-1" });
  });

  test("非法进程组证据拒绝写入", async () => {
    const value = await fixture();
    await expect(value.control.recordWriter({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, pgid: 1, startedAt: "fp" })).rejects.toThrow();
  });

  test("启动意图可记录并取消，用于崩溃窗口 fail closed", async () => {
    const value = await fixture();
    await value.control.recordWriterIntent({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, status: "started" });
    expect(value.state.agent("node").writerIntentAt).toBeTruthy();
    await value.control.recordWriterIntent({ runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, status: "cancelled" });
    expect(value.state.agent("node").writerIntentAt).toBeNull();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 Control 状态迁移超时。");
    await Bun.sleep(2);
  }
}

test("用户重开后，旧交付代际的迟到 close 不能关闭新表单", async () => {
  const value = await fixture();
  const blockRequestId = crypto.randomUUID();
  const submission = { blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
  await value.control.block(submission);
  const firstToken = value.state.agent("node").block!.deliveryToken!;
  await value.control.closeBlock(blockRequestId, submission, firstToken);
  expect(value.state.agent("node").block?.delivery).toBe("closed");
  const reopened: JournalEvent = { type: "block.reopened", at: new Date().toISOString(), runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, diagnostic: null, blockRequestId };
  await value.journal.append(reopened); value.state.apply(reopened);
  const secondToken = value.state.agent("node").block!.deliveryToken!;
  expect(secondToken).not.toBe(firstToken);
  // 旧 elicitation 的迟到 close 必须被忽略。
  await value.control.closeBlock(blockRequestId, submission, firstToken);
  expect(value.state.agent("node").block?.delivery).toBe("pending");
  // 当前代际的 close 仍然有效。
  await value.control.closeBlock(blockRequestId, submission, secondToken);
  expect(value.state.agent("node").block?.delivery).toBe("closed");
  const events = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events;
  expect(events.filter(event => event.type === "block.closed")).toHaveLength(2);
});


describe("ControlServer userNote", () => {
  test("可选意见与答案一起耐久、重读和恢复，ACP content 仍只含 Schema 答案", async () => {
    const value = await fixture({ type: "object", required: ["resolved"], properties: { resolved: { type: "boolean" } }, additionalProperties: false });
    const blockRequestId = crypto.randomUUID();
    const identity = { runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability };
    const submission = { blockRequestId, ...identity, needHelp: "需要确认", answerSchema: { type: "object", required: ["resolved"], properties: { resolved: { type: "boolean" } }, additionalProperties: false } };
    await value.control.block(submission);
    const waiting = value.control.waitForBlockAnswer(identity, { mode: "form", message: submission.needHelp, requestedSchema: submission.answerSchema });
    await value.control.answer({ blockRequestId, answer: { resolved: true }, userNote: "  保留现有交互，只修正文案。  " });
    await expect(waiting).resolves.toEqual({ action: "accept", content: { resolved: true } });
    expect((await value.control.block(submission)).userNote).toBe("保留现有交互，只修正文案。");
    expect((await value.control.workerTurnContext(identity)).block).toMatchObject({ answer: { resolved: true }, userNote: "保留现有交互，只修正文案。" });
    const answered = (await RunJournal.open(value.runId, runsRoot(value.cwd))).events.find(event => event.type === "block.answered");
    expect(answered).toMatchObject({ answer: { resolved: true }, userNote: "保留现有交互，只修正文案。" });
    await value.control.continue({ blockRequestId, ...identity });
    await expect(value.control.answer({ blockRequestId, answer: { resolved: true }, userNote: "保留现有交互，只修正文案。" })).resolves.toBeUndefined();
    await expect(value.control.answer({ blockRequestId, answer: { resolved: true }, userNote: "另一份意见" })).rejects.toThrow("不同答案或用户意见");
  });

  test("非字符串、未规范化或超长意见拒绝且不落 block.answered", async () => {
    const value = await fixture();
    const blockRequestId = crypto.randomUUID();
    await value.control.block({ blockRequestId, runId: value.runId, nodeId: "node", agentSessionId: value.agentSessionId, capability: value.capability, needHelp: "需要确认", answerSchema: { type: "object", properties: { ok: { type: "boolean" } } } });
    await expect(value.control.answer({ blockRequestId, answer: { ok: true }, userNote: 7 as unknown as string })).rejects.toThrow("必须是字符串");
    await expect(value.control.answer({ blockRequestId, answer: { ok: true }, userNote: "x".repeat(4001) })).rejects.toThrow("不能超过 4000 字");
    expect((await RunJournal.open(value.runId, runsRoot(value.cwd))).events.some(event => event.type === "block.answered")).toBe(false);
  });
});
