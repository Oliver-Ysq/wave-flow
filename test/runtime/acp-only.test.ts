import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer } from "../../src/control/control-server";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { AcpWorkerExecutor, type AcpWorkerSession } from "../../src/runtime/acp-worker-executor";
import { acpProgressIsMeaningful } from "../../src/adapters/acp-session";
import type * as acp from "@agentclientprotocol/sdk";
import { RunStateMachine } from "../../src/runtime/run-state-machine";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-acp-only-")); directories.push(cwd);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "acp", description: "ACP.", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, sandbox: "workspace-write" as const, cwd, prompt: "complete", phase: "run" };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const sessionId = "worker-session";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: sessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  return { cwd, manifest, journal, state, control: new ControlServer(journal, state), node: state.agent("node"), sessionId };
}

test("空心ACP事件不续命停滞提示，超窗只诊断一次且不中断、不cancel", async () => {
  const value = await fixture(); let prompts = 0, closed = 0, cancels = 0, capability = "", halted = false;
  let listener: ((event: import("../../src/adapters/acp-session").AcpSessionEvent) => void) | undefined;
  let finishTurn!: () => void;
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    prompt() {
      prompts++;
      void (async () => {
        while (!halted) {
          // Codex 式空心分片：进程活着、事件不断，但没有任何有意义进展。
          listener?.({ sessionId: "native", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考中" } } });
          await Bun.sleep(8);
        }
      })();
      return new Promise<{ readonly stopReason: string }>(resolve => { finishTurn = () => resolve({ stopReason: "end_turn" }); });
    },
    async cancel() { cancels++; }, close() { closed++; halted = true; }, subscribe(value) { listener = value; return () => { listener = undefined; }; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, false, 20);
  executor.bindControl(value.control);
  const pending = executor.execute(value.node);
  let diagnostics: JournalEvent[] = [];
  for (let i = 0; i < 200 && diagnostics.length === 0; i++) {
    await Bun.sleep(10);
    diagnostics = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.filter(event => event.type === "log.written" && event.diagnostic !== null);
  }
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ nodeId: "node", agentSessionId: value.sessionId, diagnostic: expect.stringContaining("停滞") });
  await Bun.sleep(60);
  expect(cancels).toBe(0);
  // 提示不伪造中断：显式 complete 仍正常完成，且不再重复诊断。
  await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: {} });
  finishTurn();
  await expect(pending).resolves.toEqual({});
  expect(prompts).toBe(1); expect(closed).toBe(1);
  expect((await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.filter(event => event.type === "log.written" && event.diagnostic !== null)).toHaveLength(1);
});

test("停滞计时只认可正文、工具与计划类ACP进展", () => {
  const text = { type: "text" as const, text: "x" };
  expect(acpProgressIsMeaningful({ sessionUpdate: "agent_message_chunk", content: text })).toBe(true);
  expect(acpProgressIsMeaningful({ sessionUpdate: "tool_call", toolCallId: "t", title: "x", status: "pending" })).toBe(true);
  expect(acpProgressIsMeaningful({ sessionUpdate: "tool_call_update", toolCallId: "t" })).toBe(true);
  expect(acpProgressIsMeaningful({ sessionUpdate: "plan", entries: [] })).toBe(true);
  expect(acpProgressIsMeaningful({ sessionUpdate: "plan_update", plan: { type: "items", planId: "p", entries: [] } })).toBe(true);
  expect(acpProgressIsMeaningful({ sessionUpdate: "plan_removed", planId: "p" })).toBe(true);
  expect(acpProgressIsMeaningful({ sessionUpdate: "agent_thought_chunk", content: text })).toBe(false);
  expect(acpProgressIsMeaningful({ sessionUpdate: "user_message_chunk", content: text })).toBe(false);
  expect(acpProgressIsMeaningful({ sessionUpdate: "available_commands_update", availableCommands: [] })).toBe(false);
  expect(acpProgressIsMeaningful({ sessionUpdate: "current_mode_update", currentModeId: "m" })).toBe(false);
});

test("原生ACP静默停滞只耐久提示一次，不自动中断；显式complete仍完成", async () => {
  const value = await fixture(); let prompts = 0, closed = 0, cancels = 0, unsubscribed = 0, capability = "";
  let finishTurn!: () => void;
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    prompt() { prompts++; return new Promise<{ readonly stopReason: string }>(resolve => { finishTurn = () => resolve({ stopReason: "end_turn" }); }); },
    async cancel() { cancels++; }, close() { closed++; },
    subscribe() { return () => { unsubscribed++; }; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, false, 20);
  executor.bindControl(value.control);
  const pending = executor.execute(value.node);
  let diagnostics: JournalEvent[] = [];
  for (let i = 0; i < 200 && diagnostics.length === 0; i++) {
    await Bun.sleep(10);
    diagnostics = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.filter(event => event.type === "log.written" && event.diagnostic !== null);
  }
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ nodeId: "node", agentSessionId: value.sessionId, diagnostic: expect.stringContaining("停滞") });
  await Bun.sleep(60);
  expect(cancels).toBe(0);
  expect(value.state.agent("node").status).toBe("running");
  await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: {} });
  finishTurn();
  await expect(pending).resolves.toEqual({});
  expect(prompts).toBe(1); expect(closed).toBe(1); expect(unsubscribed).toBe(1);
  const events = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events;
  expect(events.filter(event => event.type === "log.written" && event.diagnostic !== null)).toHaveLength(1);
  expect(events.filter(event => event.type === "agent.session")).toHaveLength(1);
  expect(events.filter(event => event.type === "agent.completed")).toHaveLength(1);
});

test("停滞提示不依赖 Run 互斥区：互斥区被占死后仍能耐久落盘", async () => {
  const value = await fixture();
  // 第一次 exclusive（recordSession）正常放行；之后的调用永久挂起，模拟 Run 互斥区被占死。
  let exclusiveCalls = 0;
  const control = new ControlServer(value.journal, value.state, <T>(operation: () => Promise<T>): Promise<T> => {
    exclusiveCalls += 1;
    return exclusiveCalls === 1 ? operation() : new Promise<T>(() => { /* 永久占用 */ });
  });
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    // 回合一直挂起、且没有任何 ACP 事件：这正是 Codex 请求长时间无响应时的形态。
    prompt() { return new Promise<{ readonly stopReason: string }>(() => { /* 永不结束 */ }); },
    async cancel() {}, close() {}, subscribe() { return () => {}; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, () => ({ name: "private", command: "fake", args: [], env: [] }), undefined, false, 20);
  executor.bindControl(control);
  const pending = executor.execute(value.node);
  let diagnostics: JournalEvent[] = [];
  for (let i = 0; i < 500 && diagnostics.length === 0; i++) {
    await Bun.sleep(20);
    diagnostics = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.filter(event => event.type === "log.written" && event.diagnostic !== null);
  }
  expect(exclusiveCalls).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ nodeId: "node", agentSessionId: value.sessionId, diagnostic: expect.stringContaining("停滞") });
  // 收尾走 stop（cancel + 拒绝 completion），不需要互斥区。
  await executor.stop(value.node);
  await expect(pending).rejects.toThrow();
});

test("回合间隙也算静默：end_turn 后读取上下文被占死仍会提示", async () => {
  const value = await fixture();
  let exclusiveCalls = 0;
  const control = new ControlServer(value.journal, value.state, <T>(operation: () => Promise<T>): Promise<T> => {
    exclusiveCalls += 1;
    return exclusiveCalls === 1 ? operation() : new Promise<T>(() => { /* 永久占用 */ });
  });
  let prompts = 0;
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    // 首个回合立刻 end_turn 但没有 complete；收尾提醒需要读上下文，而互斥区已被占死，
    // 于是节点停在"回合间隙"（active.turn 为 null）。这同样必须被判定为静默。
    prompt() { prompts += 1; return Promise.resolve({ stopReason: "end_turn" }); },
    async cancel() {}, close() {}, subscribe() { return () => {}; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, () => ({ name: "private", command: "fake", args: [], env: [] }), undefined, false, 20);
  executor.bindControl(control);
  const pending = executor.execute(value.node);
  let diagnostics: JournalEvent[] = [];
  for (let i = 0; i < 500 && diagnostics.length === 0; i++) {
    await Bun.sleep(20);
    diagnostics = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.filter(event => event.type === "log.written" && event.diagnostic !== null);
  }
  expect(prompts).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ nodeId: "node", diagnostic: expect.stringContaining("停滞") });
  await executor.stop(value.node);
  await expect(pending).rejects.toThrow();
});

test("真实会话事件持续刷新停滞窗口，complete仍只由Control决定", async () => {
  const value = await fixture(); let capability = "";
  let listener: ((event: import("../../src/adapters/acp-session").AcpSessionEvent) => void) | undefined;
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    async prompt() {
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(10);
        listener?.({ sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "活动" } } });
      }
      await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: {} });
      return { stopReason: "end_turn" };
    }, async cancel() {}, close() {}, subscribe(value) { listener = value; return () => { listener = undefined; }; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, false, 35);
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({});
  expect((await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.some(event => event.type === "log.written" && event.diagnostic !== null)).toBe(false);
});

test("等待原block答案跨越停滞窗口不重发、不制造中断", async () => {
  const value = await fixture(); let capability = "", prompts = 0;
  const blockRequestId = crypto.randomUUID();
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return this.binding!; },
    async prompt() {
      prompts++;
      const identity = { runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability };
      const answer = await value.control.block({ ...identity, blockRequestId, needHelp: "等待确认" });
      expect(answer.answer).toEqual({ ok: true });
      await value.control.continue({ ...identity, blockRequestId });
      await value.control.complete({ ...identity, summary: "done", result: {} });
      return { stopReason: "end_turn" };
    }, async cancel() {}, close() {}, subscribe() { return () => {}; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, false, 25);
  executor.bindControl(value.control);
  const pending = executor.execute(value.node);
  while (value.state.agent("node").status !== "blocked") await Bun.sleep(1);
  await Bun.sleep(100);
  expect(value.state.agent("node").status).toBe("blocked");
  await value.control.answer({ blockRequestId, answer: { ok: true } });
  await expect(pending).resolves.toEqual({});
  expect(prompts).toBe(1);
  expect((await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.some(event => event.type === "log.written" && event.diagnostic !== null)).toBe(false);
});

for (const operation of ["block", "complete"] as const) test(`Control ${operation}落盘跨停滞窗口属于控制等待，不制造诊断`, async () => {
  const value = await fixture(); let capability = "";
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = value.journal.append.bind(value.journal);
  const appendSpy = spyOn(value.journal, "append").mockImplementation(async event => {
    if (operation === "block" && event.type === "block.created") { entered(); await gate; }
    return append(event);
  });
  const writeResult = value.journal.writeResult.bind(value.journal);
  const resultSpy = spyOn(value.journal, "writeResult").mockImplementation(async (...args) => {
    if (operation === "complete") { entered(); await gate; }
    return writeResult(...args);
  });
  const blockRequestId = crypto.randomUUID();
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return this.binding!; },
    async prompt() {
      const identity = { runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability };
      if (operation === "block") {
        await value.control.block({ ...identity, blockRequestId, needHelp: "确认" });
        await value.control.continue({ ...identity, blockRequestId });
      }
      await value.control.complete({ ...identity, summary: "done", result: {} });
      return { stopReason: "end_turn" };
    }, async cancel() {}, close() {}, subscribe() { return () => {}; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined,
    identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, false, 25);
  executor.bindControl(value.control);
  const pending = executor.execute(value.node);
  try {
    await started;
    await Bun.sleep(100);
    expect(value.control.isWorkerWaiting("node", value.sessionId)).toBe(true);
    expect(value.state.agent("node").status).toBe("running");
    release();
    if (operation === "block") {
      while (value.state.agent("node").status !== "blocked") await Bun.sleep(1);
      await value.control.answer({ blockRequestId, answer: {} });
    }
    await expect(pending).resolves.toEqual({});
    expect((await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.some(event => event.type === "log.written" && event.diagnostic !== null)).toBe(false);
  } finally { release(); appendSpy.mockRestore(); resultSpy.mockRestore(); }
});

test("原session暂停跨窗口后recover重置计时且只发送现场检查回合", async () => {
  const value = await fixture(); let capability = "", finish!: (turn: { stopReason: string }) => void;
  const prompts: string[] = [];
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return this.binding!; },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) return new Promise(resolve => { finish = resolve; });
      await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: {} });
      return { stopReason: "end_turn" };
    }, async cancel() { finish({ stopReason: "cancelled" }); }, close() {}, subscribe() { return () => {}; },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, false, 30);
  executor.bindControl(value.control);
  const pending = executor.execute(value.node);
  while (!prompts.length) await Bun.sleep(1);
  await executor.pause(value.node);
  await Bun.sleep(120);
  expect(prompts).toHaveLength(1);
  await executor.recover(value.node);
  await expect(pending).resolves.toEqual({});
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("不要重发原始任务");
  expect((await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.some(event => event.type === "log.written" && event.diagnostic !== null)).toBe(false);
});

test("其他session事件不能掩盖当前Worker停滞", async () => {
  const value = await fixture(); let timer: ReturnType<typeof setInterval> | undefined;
  const session: AcpWorkerSession = {
    binding: { launcherId: "codex-acp", sessionId: "native", capabilities: {} }, async initialize() {},
    async createSession() { return this.binding!; }, prompt() { return new Promise(() => {}); },
    async cancel() {}, close() {},
    subscribe(listener) {
      timer = setInterval(() => listener({ sessionId: "unrelated", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "其他会话" } } }), 5);
      return () => clearInterval(timer);
    },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, undefined, undefined, false, 25);
  executor.bindControl(value.control);
  const pending = executor.execute(value.node);
  let diagnostics: JournalEvent[] = [];
  for (let i = 0; i < 200 && diagnostics.length === 0; i++) {
    await Bun.sleep(10);
    diagnostics = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events.filter(event => event.type === "log.written" && event.diagnostic !== null);
  }
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ diagnostic: expect.stringContaining("停滞") });
  // 其他会话的事件只掩盖提示计时，不制造中断；显式停止仍走用户停止路径。
  await executor.stop(value.node);
  await expect(pending).rejects.toThrow("用户停止 Run。");
});

test("非法停滞窗口在启动前拒绝", () => {
  for (const window of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, undefined, undefined, undefined, undefined, false, window)).toThrow("正整数");
  }
});

for (const stage of ["initialize", "createSession"] as const) test(`停止发生在${stage}等待时仍清理，迟到启动不投递任务`, async () => {
 const value = await fixture(); let entered!: () => void, release!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 let prompts = 0, closed = 0, pipeClosed = 0;
 const session: AcpWorkerSession = {
  binding:null,
  async initialize(){ if(stage==="initialize"){entered();await gate;} },
  async createSession(){ if(stage==="createSession"){entered();await gate;} return {launcherId:"test",sessionId:"native",capabilities:{}}; },
  async prompt(){prompts++;return {stopReason:"end_turn"};},
  async cancel(){throw new Error("尚未建立可取消会话");}, close(){closed++;}
 };
 const executor = new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[],close(){pipeClosed++;}} as acp.McpServer));
 executor.bindControl(value.control);
 const running = executor.execute(value.node).then(()=>"unexpected",error=>String(error));
 await started;
 await expect(executor.stop(value.node)).rejects.toThrow("尚未建立");
 expect(await Promise.race([running,Bun.sleep(500).then(()=>"pending")])).toContain("停止未确认");
 release(); await Bun.sleep(1);
 expect(prompts).toBe(0); expect(closed).toBe(1);
 expect(pipeClosed).toBe(stage==="createSession"?1:0);
 expect((await RunJournal.open(value.manifest.runId,runsRoot(value.cwd))).events.some(e=>e.type==="agent.session")).toBe(false);
});

test("ACP Worker 只在 durable binding 与 capability complete 后完成", async () => {
  const value = await fixture();
  let capability = "";
  let managed = "";
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) { managed = text; await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: { ok: true } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "/mcp", args: [], env: [] }; });
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(managed).toContain("高优先级、不可省略");
  expect(managed).toContain("即使业务任务要求“只回复”“只输出 JSON”");
  expect(managed).toContain("wave_flow_complete");
  expect(managed).toContain("延迟加载");
  expect(managed).toContain("工具搜索/发现");
  const opened = await RunJournal.open(value.manifest.runId, runsRoot(value.cwd));
  expect(opened.events).toContainEqual(expect.objectContaining({ type: "agent.session", delivery: "acp", acp: expect.objectContaining({ sessionId: "native-session" }) }));
});

test("受管写ACP complete后先close，再由成果阶段核验退出；核验失败不得丢句柄", async () => {
  const value = await fixture(); let capability = "", closed = 0, verifies = 0, fail = true;
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    async prompt() { await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: { ok: true } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() { closed++; }, async verifyClosed() { verifies++; if (fail) throw new Error("组内仍有迟到进程"); },
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; }, undefined, true);
  executor.bindControl(value.control);
  expect(await executor.execute(value.node)).toEqual({ ok: true }); expect(closed).toBe(1);
  await expect(executor.finalizeCompleted(value.state.agent("node"))).rejects.toThrow("迟到进程");
  fail = false; await executor.finalizeCompleted(value.state.agent("node")); expect(verifies).toBe(2);
  await executor.finalizeCompleted(value.state.agent("node")); expect(verifies).toBe(2);
});

for(const answered of [false,true])test(`收尾从Control补回原block，answered=${answered}，不新建请求或代替continue`,async()=>{
 const value=await fixture();let identity:any;const blockRequestId=crypto.randomUUID();const prompts:string[]=[];
 const needHelp="请选择数字",answerSchema={type:"object",properties:{x:{type:"integer"}},required:["x"],additionalProperties:false};
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(text){
  prompts.push(text);
  if(prompts.length===1){void value.control.block({...identity,blockRequestId,needHelp,answerSchema}).catch(()=>{});while(value.state.agent("node").status!=="blocked")await Bun.sleep(1);if(answered)await value.control.answer({blockRequestId,answer:{x:41}});return {stopReason:"end_turn"};}
  expect(text).toContain(blockRequestId);expect(text).toContain(needHelp);expect(text).toContain(JSON.stringify(answerSchema));
  expect(text).toContain(answered?"原block已有耐久答案":"用户尚未回答");
  if(!answered)expect(text).toContain("不是永久禁令");
  expect(value.state.agent("node").status).toBe("blocked");
  if(!answered)await value.control.answer({blockRequestId,answer:{x:41}});
  const reordered={additionalProperties:false,required:["x"],properties:{x:{type:"integer"}},type:"object"};
  const original=await value.control.block({...identity,blockRequestId,needHelp,answerSchema:reordered});expect(original.answer).toEqual({x:41});
  await value.control.continue({...identity,blockRequestId});
  await value.control.complete({...identity,summary:"done",result:{value:42}});return {stopReason:"end_turn"};
 },async cancel(){},close(){}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,i=>{identity=i;return {name:"private",command:"fake",args:[],env:[]};});executor.bindControl(value.control);
 expect(await executor.execute(value.node)).toEqual({value:42});expect(prompts).toHaveLength(2);
 const events=(await RunJournal.open(value.manifest.runId,runsRoot(value.cwd))).events;
 expect(events.filter(e=>e.type==="block.created")).toHaveLength(1);expect(events.filter(e=>e.type==="agent.continued")).toHaveLength(1);
});

test("停止发生在收尾事实读取期间，不创建迟到收尾回合",async()=>{
 const value=await fixture();let release!:()=>void,reading!:()=>void,prompts=0;
 const entered=new Promise<void>(done=>reading=done),hold=new Promise<void>(done=>release=done);
 const original=value.control.workerTurnContext.bind(value.control);
 value.control.workerTurnContext=async identity=>{reading();await hold;return original(identity);};
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return {stopReason:"end_turn"};},async cancel(){},close(){}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[]}));executor.bindControl(value.control);
 const running=executor.execute(value.node);void running.catch(()=>{});await entered;await executor.stop(value.node);release();
 await expect(running).rejects.toThrow("用户停止");expect(prompts).toBe(1);
});

test("stop的cancel忽略signal时仍在宿主预算内拒绝并清理会话", async () => {
 const value = await fixture(); let started!: () => void; let closed = 0;
 const entered = new Promise<void>(resolve => { started = resolve; });
 const session: AcpWorkerSession = { binding:null, async initialize(){}, async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};}, async prompt(){started();return new Promise(()=>{});}, async cancel(){return new Promise(()=>{});}, close(){closed++;} };
 const executor = new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session);
 executor.bindControl(value.control);
 const running = executor.execute(value.node).then(()=>"unexpected", error=>String(error));
 await entered;
 const before = Date.now();
 await expect(executor.stop(value.node)).rejects.toThrow("控制等待已取消");
 expect(Date.now()-before).toBeLessThan(18_000);
 expect(await running).toContain("停止未确认");
 expect(closed).toBe(1);
}, 20_000);

for(const lateTurn of [false,true])test(`cancel抛错也收敛执行并释放会话/MCP，迟到end_turn=${lateTurn}`,async()=>{
 const value=await fixture();let finish!:(turn:{stopReason:string})=>void,prompts=0,closed=0,pipeClosed=0;
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return new Promise(done=>finish=done);},async cancel(){throw new Error("cancel transport failed");},close(){closed++;}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[],close(){pipeClosed++;}} as acp.McpServer));executor.bindControl(value.control);
 const running=executor.execute(value.node);
 const outcome=running.then(()=>"unexpected success",error=>String(error));
 while(!finish)await Bun.sleep(1);
 await expect(executor.stop(value.node)).rejects.toThrow("cancel transport failed");
 if(lateTurn)finish({stopReason:"end_turn"});
 const result=await Promise.race([outcome,Bun.sleep(200).then(()=>"pending")]);
 expect(result).toContain("停止未确认：cancel transport failed");
 expect(closed).toBe(1);expect(pipeClosed).toBe(1);expect(prompts).toBe(1);
 await expect(executor.stop(value.node)).rejects.toThrow("没有可控制");
 const events=(await RunJournal.open(value.manifest.runId,runsRoot(value.cwd))).events;
 expect(events.filter(event=>event.type==="agent.completed")).toHaveLength(0);
});

test("超大协议事实拒绝收尾而非截断身份或无限重试",async()=>{
 const value=await fixture();let prompts=0;
 value.control.workerTurnContext=async()=>({status:"running",block:null,resultSchema:{type:"object",description:"中".repeat(18000)}});
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return {stopReason:"end_turn"};},async cancel(){},close(){}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[]}));executor.bindControl(value.control);
 await expect(executor.execute(value.node)).rejects.toThrow("超过48KiB");expect(prompts).toBe(1);
});

test("ACP Worker cancel 确认后仅在同一 session recover", async () => {
  const value = await fixture();
  let capability = "";
  let releaseFirst!: (result: { readonly stopReason: string }) => void;
  const prompts: string[] = [];
  const session: AcpWorkerSession = {
    get binding() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "recovered", result: { ok: true } });
      return { stopReason: "end_turn" };
    },
    async cancel() { releaseFirst({ stopReason: "cancelled" }); }, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "/mcp", args: [], env: [] }; });
  executor.bindControl(value.control);
  const running = executor.execute(value.node);
  while (prompts.length === 0) await Bun.sleep(1);
  await executor.pause(value.node);
  await executor.recover(value.node);
  await expect(running).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("检查当前工作目录");
  expect(prompts[1]).toContain("工具搜索/发现");
});

for(const failure of ["end_turn","transport","abort","cancel_error","pending_cancel_transport"] as const)test(`暂停确认失败${failure}不悬挂、不续发且释放原会话`,async()=>{
 const value=await fixture();let finish!:(turn:{stopReason:string})=>void,reject!:(error:Error)=>void,prompts=0,closed=0;
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return new Promise((done,fail)=>{finish=done;reject=fail;});},async cancel(){if(failure==="cancel_error")throw new Error("cancel failed");if(failure==="pending_cancel_transport")await new Promise<void>(()=>{});},close(){closed++;}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[]}));executor.bindControl(value.control);
 const running=executor.execute(value.node);const outcome=running.then(()=>"unexpected",error=>String(error));
 while(!finish)await Bun.sleep(1);
 const controller=new AbortController();const pausing=executor.pause(value.node,controller.signal);
 const paused=pausing.then(()=>"unexpected",error=>String(error));
 await Bun.sleep(1);
 if(failure==="end_turn")finish({stopReason:"end_turn"});
 if(failure==="transport"||failure==="pending_cancel_transport")reject(new Error("transport failed"));
 if(failure==="abort")controller.abort();
 expect(await Promise.race([paused,Bun.sleep(200).then(()=>"pending")])).not.toBe("pending");
 expect(await Promise.race([outcome,Bun.sleep(200).then(()=>"pending")])).not.toBe("pending");
 finish({stopReason:"end_turn"});await Bun.sleep(1);
 expect(closed).toBe(1);expect(prompts).toBe(1);
 await expect(executor.recover(value.node)).rejects.toThrow("没有可控制");
});

test("两个CLI使用相同通用完成协议，第二次end_turn仍漏报只拒绝、不重跑或代报",async()=>{
 const guides:string[]=[];
 for(const cli of ["codex","kimi"] as const){
  const value=await fixture(),prompts:string[]=[];
  const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:`${cli}-acp`,sessionId:"native",capabilities:{}};},async prompt(text){prompts.push(text);return {stopReason:"end_turn"};},async cancel(){},close(){}};
  const executor=new AcpWorkerExecutor({id:`${cli}-acp`,command:"fake",args:[]},()=>session,undefined,()=>({name:"wave-flow-worker-control",command:"fake",args:[],env:[]}));
  executor.bindControl(value.control);
  await expect(executor.execute({...value.node,cli,request:{...value.node.request,cli}})).rejects.toThrow("未收到 wave-flow complete");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("不要重做业务任务");
  for(const text of prompts){
   expect(text).toContain("server：wave-flow-worker-control");
   expect(text).toContain("summary: string, result: object");
   expect(text).toContain("属于其他server");
   expect(text).not.toMatch(/Codex|Kimi|ALL_TOOLS|mcp__|tools\.|exec\/代码/);
  }
  guides.push(prompts[0]);
  const opened=await RunJournal.open(value.manifest.runId,runsRoot(value.cwd));
  expect(opened.events.filter(event=>event.type==="agent.completed")).toHaveLength(0);
  expect(opened.events.filter(event=>event.type==="agent.session")).toHaveLength(1);
 }
 expect(guides[0]).toBe(guides[1]);
});

test("回合间隙 pause 本地挂起不中断，recover 后同一 session 只发检查现场回合", async () => {
  const value = await fixture(); let capability = "";
  const prompts: string[] = [];
  let reading!: () => void, releaseRead!: () => void;
  const entered = new Promise<void>((done) => { reading = done; });
  const hold = new Promise<void>((done) => { releaseRead = done; });
  const original = value.control.workerTurnContext.bind(value.control);
  value.control.workerTurnContext = async (identity) => { reading(); await hold; return original(identity); };
  let cancels = 0;
  const session: AcpWorkerSession = {
    get binding() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    async initialize() {}, async createSession() { return { launcherId: "codex-acp", sessionId: "native", capabilities: {} }; },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) return { stopReason: "end_turn" };
      await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: { ok: true } });
      return { stopReason: "end_turn" };
    },
    async cancel() { cancels++; }, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, (identity) => { capability = identity.capability; return { name: "private", command: "fake", args: [], env: [] }; });
  executor.bindControl(value.control);
  const running = executor.execute(value.node);
  // 第一个 turn 已 end_turn，runTurn 正在 await 收尾事实读取：这正是曾经的“间隙 pause 炸掉整 Run”窗口。
  await entered;
  await executor.pause(value.node);
  expect(cancels).toBe(0);
  releaseRead();
  await Bun.sleep(10);
  // 间隙暂停不得发起完成提醒回合，也不得中断 execute。
  expect(prompts).toHaveLength(1);
  await executor.recover(value.node);
  await expect(running).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("检查当前工作目录");
  expect(prompts[1]).not.toContain("不要重做业务任务");
});

test("首个 end_turn 遗漏 complete 时仅补发同 session 的完成提醒", async () => {
  const value = await fixture(); let capability = ""; const prompts: string[] = [];
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) { prompts.push(text); if (prompts.length === 1) return { stopReason: "end_turn" }; await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "recovered-report", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "/mcp", args: [], env: [] }; }); executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2); expect(prompts[1]).toContain("不要重做业务任务");
  expect(prompts[1]).toContain("工具搜索/发现");
});

test("真实 Worker session 仅注入节点私有的 Control MCP", async () => {
  const value = await fixture(); let capability = ""; let servers: readonly acp.McpServer[] = [];
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession(_cwd, _signal, mcpServers = []) { servers = mcpServers; return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt() { await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "mcp", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor(
    { id: "codex-acp", command: "fake", args: [] },
    () => session,
    undefined,
    identity => { capability = identity.capability; return { name: "wave-flow-worker-control", command: "/wave-flow-desktop-engine", args: ["__worker-mcp"], env: [{ name: "WF_WORKER_CONTROL_SOCKET", value: "/private/control.sock" }] }; },
  );
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(servers).toEqual([expect.objectContaining({ name: "wave-flow-worker-control", command: "/wave-flow-desktop-engine", args: ["__worker-mcp"] })]);
});

test("真实 Worker 创建带私有 MCP 的 session 时等待其启动完成", async () => {
  const value = await fixture(); let capability = ""; let startupWait: number | undefined;
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession(_cwd, _signal, _servers = [], wait) { startupWait = wait; return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt() { await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "mcp-ready", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor(
    { id: "codex-acp", command: "fake", args: [] },
    () => session,
    undefined,
    identity => { capability = identity.capability; return { name: "wave-flow-worker-control", command: "/wave-flow-desktop-engine", args: ["__worker-mcp"], env: [] }; },
  );
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(startupWait).toBe(10_000);
});

test("ACP 启动 initialize 超时会中断节点并留下启动阶段诊断", async () => {
  const value = await fixture();
  let closed = 0;
  const session: AcpWorkerSession = {
    binding: null,
    initialize() { return new Promise(() => {}); },
    async createSession() { throw new Error("不应到达 session/new"); },
    async prompt() { throw new Error("不应到达 prompt"); },
    async cancel() {},
    close() { closed += 1; },
  };
  const executor = new AcpWorkerExecutor(
    { id: "codex-acp", command: "fake", args: [] },
    () => session,
    undefined,
    undefined,
    undefined,
    false,
    20,
    undefined,
    undefined,
    50,
  );
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).rejects.toThrow("启动超时");
  expect(closed).toBe(1);
  const events = (await RunJournal.open(value.manifest.runId, runsRoot(value.cwd))).events;
  expect(events.some(event => event.type === "log.written" && event.nodeId === "node" && event.message.includes("启动中"))).toBe(true);
  expect(events.some(event => event.type === "log.written" && event.diagnostic?.includes("启动超时"))).toBe(true);
  expect(value.state.agent("node").hint).toContain("正在自动恢复");
});
