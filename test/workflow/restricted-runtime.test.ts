import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { PolicyEnforcingHost } from "../../src/runtime/policy-host";
import { RunRuntime } from "../../src/runtime/run-runtime";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { DecisionGateRequest, ExecutionBatch, PhaseVisit, WorkflowExecutionHost } from "../../src/runtime/workflow-host";
import type { JsonObject } from "../../src/shared/json";
import type { NormalizedAgentRequest } from "../../src/shared/workflow-types";
import { executeWorkflow } from "../../src/workflow/execute-workflow";
import { compileRestrictedWorkflow } from "../../src/workflow/restricted/restricted-runtime";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

class MemoryHost implements WorkflowExecutionHost {
  readonly agents: NormalizedAgentRequest[] = [];
  readonly batches: Array<{ sequence: number; mode: "serial" | "parallel" }> = [];
  readonly phases: string[] = [];
  readonly gates: DecisionGateRequest[] = [];
  constructor(private readonly respond: (request: NormalizedAgentRequest) => Promise<JsonObject | null> = async (request) => ({ id: request.id })) {}
  async agent(request: NormalizedAgentRequest, batch: ExecutionBatch): Promise<JsonObject | null> {
    this.agents.push(request);
    this.batches.push(batch);
    return this.respond(request);
  }
  phase(title: string): PhaseVisit { this.phases.push(title); return { executionAttemptId: 1, phaseVisitId: this.phases.length, title, occurrence: 1 }; }
  log(): void {}
  async decisionGate(request: DecisionGateRequest): Promise<JsonObject> {
    this.gates.push(request);
    return { gate: request.id };
  }
}

const VALID_HEAD = `const meta = { name: "restricted-ok", description: "ok", phases: [{ title: "scan" }, { title: "汇总" }] };\n`;

describe("受限 Workflow 脚本静态白名单", () => {
  const rejections: Array<[string, string, string]> = [
    ["process", "return process.cwd();", "未注入的标识符：process"],
    ["Bun", "return Bun.version;", "未注入的标识符：Bun"],
    ["fetch", 'return fetch("https://example.com");', "未注入的标识符：fetch"],
    ["globalThis", "return globalThis;", "未注入的标识符：globalThis"],
    ["eval", 'return eval("1");', "未注入的标识符：eval"],
    ["Function 构造器", 'return new Function("return 1")();', "未注入的标识符：Function"],
    ["constructor 成员", 'return ({}).constructor;', "禁止访问 constructor 成员"],
    ["计算 constructor 成员", 'return ({})["constructor"];', "禁止访问 constructor 成员"],
    ["__proto__ 成员", "return ({}).__proto__;", "禁止访问 __proto__ 成员"],
    ["静态 import", 'import x from "wave-flow";\n', "禁止一切 import/export"],
    ["动态 import", 'return import("wave-flow");', "禁止动态 import()"],
    ["this", "return this;", "禁止 this/super"],
    ["class", "class C {}\n", "禁止 class"],
    ["export", "export const x = 1;\n", "禁止一切 import/export"],
    ["Math（replay 确定性）", "return Math.random();", "未注入的标识符：Math"],
    ["Object", "return Object.keys({});", "未注入的标识符：Object"],
    ["Promise", "return Promise.resolve(1);", "未注入的标识符：Promise"],
    ["标签语句", "loop: for (;;) { break loop; }", "禁止标签语句"],
  ];
  for (const [name, body, message] of rejections) {
    test(`拒绝 ${name}`, () => {
      const source = body.startsWith("import") || body.startsWith("export") || body.startsWith("class")
        ? `${body}${VALID_HEAD}async function run(args) { return null; }`
        : `${VALID_HEAD}async function run(args) { ${body} }`;
      expect(() => compileRestrictedWorkflow(source)).toThrow(message);
    });
  }

  test("拒绝非纯字面量 meta、缺失 run 与多余顶层语句", () => {
    expect(() => compileRestrictedWorkflow(`const meta = { name: "x".toUpperCase() };\nasync function run(args) { return null; }`)).toThrow("纯字面量");
    expect(() => compileRestrictedWorkflow(`${VALID_HEAD}`)).toThrow("async function run");
    expect(() => compileRestrictedWorkflow(`${VALID_HEAD}async function run(args) { return 1; }\nconsole.log(1);`)).toThrow("未注入的标识符：console");
    expect(() => compileRestrictedWorkflow(`${VALID_HEAD}function run(args) { return 1; }`)).toThrow("async function run");
  });
});

describe("受限 Workflow 脚本正常执行", () => {
  test("phase/agent/parallel/pipeline/log 与 JSON 值往返", async () => {
    const source = `${VALID_HEAD}
type Seen = { id: string };
async function run(args) {
  phase("scan");
  log("开始");
  const pair = await parallel([
    () => agent("扫描 A", { id: "a", cli: "codex" }),
    () => agent("扫描 B", { id: "b", cli: "codex" }),
  ]);
  phase("汇总");
  const items = ["x", "y"];
  const done = await pipeline(items, (item) => agent("处理 " + item, { id: "p-" + item, cli: "codex" }));
  const first = pair[0];
  return { pair, done, note: args.note, firstId: first.id };
}`;
    const module = compileRestrictedWorkflow(source);
    expect(module.meta.name).toBe("restricted-ok");
    const host = new MemoryHost();
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-restricted-"));
    directories.push(cwd);
    const result = await executeWorkflow(module, { note: "你好" }, host, { cwd }) as { pair: Array<{ id: string } | null>; done: unknown[]; note: string; firstId: string };
    expect(result.note).toBe("你好");
    expect(result.firstId).toBe("a");
    expect(result.done).toEqual([{ id: "p-x" }, { id: "p-y" }]);
    // parallel()/pipeline() 的完成回调可交错；只约束完整节点集合，顺序语义由
    // result.done 与 batch mode 覆盖，不能把异步完成先后误当作 API 契约。
    expect(host.agents.map((request) => request.id).sort()).toEqual(["a", "b", "p-x", "p-y"]);
    expect(host.phases).toEqual(["scan", "汇总"]);
    expect(host.batches.filter((batch) => batch.mode === "parallel").length).toBe(4);
  });

  test("契约错误跨 realm 还原类型：parallel 内 phase() 必须抛出而非降级为 null", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  return parallel([() => phase("汇总")]);
}`;
    const module = compileRestrictedWorkflow(source);
    const host = new MemoryHost();
    await expect(executeWorkflow(module, {}, host)).rejects.toThrow("不能在 parallel() thunk 或 pipeline() stage 中调用");
  });

  test("重复节点 id 使 Run 失败而不是静默 null", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  await agent("一", { id: "same", cli: "codex" });
  return agent("二", { id: "same", cli: "codex" });
}`;
    const module = compileRestrictedWorkflow(source);
    await expect(executeWorkflow(module, {}, new MemoryHost())).rejects.toThrow("必须唯一");
  });
});

describe("受限 Workflow Policy 护栏", () => {
  test("节点总数超限被拒绝", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  for (let index = 0; index < 3; index += 1) {
    await agent("任务 " + index, { id: "t-" + index, cli: "codex" });
  }
  return null;
}`;
    const module = compileRestrictedWorkflow(source);
    const policy = new PolicyEnforcingHost(new MemoryHost(), { maxNodes: 2, maxPhaseVisits: 10, maxGates: 10 });
    await expect(executeWorkflow(module, {}, policy)).rejects.toThrow("Policy 上限 2");
  });

  test("phase 循环超限被拒绝", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  for (let index = 0; index < 5; index += 1) phase("scan");
  return null;
}`;
    const module = compileRestrictedWorkflow(source);
    const policy = new PolicyEnforcingHost(new MemoryHost(), { maxNodes: 10, maxPhaseVisits: 3, maxGates: 10 });
    await expect(executeWorkflow(module, {}, policy)).rejects.toThrow("Policy 上限 3");
  });
});

async function gateRuntime(executor: AgentNodeExecutor, source: string): Promise<{ runtime: RunRuntime; module: ReturnType<typeof compileRestrictedWorkflow> }> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-gate-"));
  directories.push(cwd);
  const workflowPath = join(cwd, "source.ts");
  await writeFile(workflowPath, source, "utf8");
  const module = compileRestrictedWorkflow(source);
  const runtime = await RunRuntime.create({ workflow: module, input: {}, workflowSource: source, clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor });
  return { runtime, module };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待条件超时。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("受限 Workflow 决策门", () => {
  const gateSource = `const meta = { name: "gate-flow", description: "gate", phases: [{ title: "work" }] };
async function run(args) {
  phase("work");
  const answer = await decisionGate({ id: "approve", question: "是否继续执行？", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });
  if (!answer.ok) throw new Error("用户拒绝继续");
  return agent("执行工作", { id: "work-1", cli: "codex" });
}`;

  test("gate durable-first：先落盘再等待，答案校验 Schema 后唤醒脚本", async () => {
    const { runtime, module } = await gateRuntime({ execute: async () => ({ done: true }) }, gateSource);
    const task = runtime.run(module);
    await waitFor(() => runtime.snapshot().gates.length === 1);
    const gate = runtime.snapshot().gates[0];
    expect(gate).toMatchObject({ gateId: "approve", question: "是否继续执行？", answer: null, executionAttemptId: 1, phaseVisitId: 1 });
    await expect(runtime.answerGate("approve", { ok: 1 } as unknown as JsonObject)).rejects.toThrow("answerSchema");
    await expect(runtime.answerGate("unknown", { ok: true })).rejects.toThrow("未知决策门");
    await runtime.answerGate("approve", { ok: true });
    await expect(task).resolves.toEqual({ done: true });
    expect(runtime.snapshot()).toMatchObject({ status: "completed", gates: [{ gateId: "approve", answer: { ok: true } }] });
    await expect(runtime.answerGate("approve", { ok: true })).rejects.toThrow("已回答");
  });

  test("stop 拒绝 pending gate，Workflow 调用栈随之收敛", async () => {
    const { runtime, module } = await gateRuntime({ execute: async () => ({ done: true }) }, gateSource);
    // 立即接管 rejection：stop 期间 Workflow 栈就会退出，不能等到断言语句才 attach。
    const task = runtime.run(module).then(() => null, (error: unknown) => error);
    await waitFor(() => runtime.snapshot().gates.length === 1);
    await runtime.stop();
    const failure = await task;
    expect(failure).not.toBeNull();
    expect(String((failure as { message?: unknown })?.message ?? failure)).toContain("决策门不再等待答案");
    expect(runtime.snapshot().status).toBe("cancelled");
  });

  test("显式 resume 重放已答 gate 与 completed 前缀，只在未答 gate 处继续等待", async () => {
    let executions = 0;
    const twoGateSource = `const meta = { name: "gate-replay", description: "replay", phases: [{ title: "work" }] };
async function run(args) {
  phase("work");
  const first = await decisionGate({ id: "g1", question: "第一问" });
  await agent("工作一", { id: "w1", cli: "codex", input: { first: first.ok } });
  const second = await decisionGate({ id: "g2", question: "第二问" });
  return { second: second.ok };
}`;
    const { runtime, module } = await gateRuntime({ execute: async () => { executions += 1; return { n: executions }; } }, twoGateSource);
    const runId = runtime.snapshot().id;
    const storeRoot = join(runtime.journal.directory, "..");
    const task = runtime.run(module);
    await waitFor(() => runtime.snapshot().gates.length === 1);
    await runtime.answerGate("g1", { ok: true });
    await waitFor(() => runtime.snapshot().gates.length === 2);
    // 模拟 Engine 重启：旧 host 的等待消失，只读重开后显式 resume。
    const resumed = await RunRuntime.resume(runId, { execute: async () => { executions += 1; return { n: executions }; } }, storeRoot);
    void task.catch(() => undefined);
    const replayTask = resumed.run(module);
    await waitFor(() => resumed.snapshot().gates.filter((gate) => gate.answer === null).length === 1);
    expect(resumed.snapshot().gates.map((gate) => gate.gateId)).toEqual(["g1", "g2"]);
    await resumed.answerGate("g2", { ok: true });
    await expect(replayTask).resolves.toEqual({ second: true });
    // 已答 g1 与 completed 的 w1 都被复用：整个 resume 没有新的真实执行。
    expect(executions).toBe(1);
    expect(resumed.snapshot().status).toBe("completed");
  });

  test("resume 重跑节点后首次创建 gate 绑定新 attempt 的真实阶段访问", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  await agent("先执行", { id: "work-1", cli: "codex" });
  return decisionGate("approve-after-restart", "是否继续？", { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
}`;
    const module = compileRestrictedWorkflow(source);
    const { runtime } = await gateRuntime({ execute: async () => null }, source);
    await runtime.run(module).catch(() => undefined);
    expect(runtime.snapshot().status).toBe("interrupted");
    expect(runtime.snapshot().gates).toHaveLength(0);

    const resumed = await RunRuntime.resume(runtime.snapshot().id, { execute: async () => ({ done: true }) }, join(runtime.journal.directory, ".."));
    const task = resumed.run(module);
    await waitFor(() => resumed.snapshot().gates.length === 1);
    expect(resumed.snapshot().gates[0]).toMatchObject({ gateId: "approve-after-restart", executionAttemptId: 2, phaseVisitId: 1 });
    await resumed.answerGate("approve-after-restart", { ok: true });
    await expect(task).resolves.toEqual({ ok: true });
  });

  test("completed 前缀后 gate 首次写入失败，resume 只重建 gate 而不重跑 Worker", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  await agent("已交付", { id: "work-1", cli: "codex" });
  return decisionGate("new-gate", "是否继续？");
}`;
    let workers = 0;
    const { runtime, module } = await gateRuntime({ execute: async () => { workers++; return { done: true }; } }, source);
    const append = runtime.journal.append.bind(runtime.journal);
    const injected = spyOn(runtime.journal, "append").mockImplementation(async event => {
      if (event.type === "gate.created") throw new Error("gate 写入故障");
      return append(event);
    });
    try { await expect(runtime.run(module)).rejects.toThrow("gate 写入故障"); }
    finally { injected.mockRestore(); }
    expect(runtime.snapshot().gates).toHaveLength(0);
    const resumed = await RunRuntime.resume(runtime.snapshot().id, { execute: async () => { workers++; return { done: true }; } }, join(runtime.journal.directory, ".."));
    const task = resumed.run(module);
    await waitFor(() => resumed.snapshot().gates.length === 1);
    expect(resumed.snapshot().gates[0]).toMatchObject({ gateId: "new-gate", executionAttemptId: 2, phaseVisitId: 1 });
    expect(workers).toBe(1);
    await resumed.answerGate("new-gate", { ok: true });
    await expect(task).resolves.toEqual({ ok: true });
  });

  test("replay 中 gate 请求与已耐久事实不匹配时拒绝", async () => {
    const { runtime, module } = await gateRuntime({ execute: async () => ({ done: true }) }, gateSource);
    const task = runtime.run(module);
    await waitFor(() => runtime.snapshot().gates.length === 1);
    void task.catch(() => undefined);
    const storeRoot = join(runtime.journal.directory, "..");
    const resumed = await RunRuntime.resume(runtime.snapshot().id, { execute: async () => ({ done: true }) }, storeRoot);
    const changedSource = gateSource.replace("是否继续执行？", "改过的问题");
    const changedModule = compileRestrictedWorkflow(changedSource);
    await expect(resumed.run(changedModule)).rejects.toThrow("与已耐久决策门不匹配");
    expect(resumed.snapshot().gates[0].answer).toBeNull();
  });

  test("decisionGate 请求形状由桥校验", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  return decisionGate({ id: "bad gate!", question: "" });
}`;
    const module = compileRestrictedWorkflow(source);
    await expect(executeWorkflow(module, {}, new MemoryHost())).rejects.toThrow("id 必须为");
  });

  test("decisionGate 接受对象和三参数等价写法", async () => {
    const source = `${VALID_HEAD}
async function run(args) {
  phase("scan");
  return decisionGate("approve", "是否继续？", { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
}`;
    const module = compileRestrictedWorkflow(source);
    const host = new MemoryHost();
    await expect(executeWorkflow(module, {}, host)).resolves.toEqual({ gate: "approve" });
    expect(host.gates).toEqual([{ id: "approve", question: "是否继续？", answerSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }]);
  });
});
