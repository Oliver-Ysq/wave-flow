import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkflowExecutionHost } from "../../src/runtime/workflow-host";
import type { JsonObject } from "../../src/shared/json";
import type { NormalizedAgentRequest, WorkflowMeta, WorkflowModule } from "../../src/shared/workflow-types";
import { agent, log, parallel, phase, pipeline } from "../../src/workflow/author-api";
import { executeWorkflow } from "../../src/workflow/execute-workflow";

const meta: WorkflowMeta = {
  name: "api-check",
  description: "Verify author API behavior.",
  phases: [{ title: "scan" }, { title: "summarize" }],
};

class MemoryHost implements WorkflowExecutionHost {
  readonly agents: NormalizedAgentRequest[] = [];
  readonly batches: Array<{ sequence: number; mode: "serial" | "parallel" }> = [];
  readonly phases: string[] = [];
  readonly logs: string[] = [];
  constructor(private readonly respond: (request: NormalizedAgentRequest) => Promise<JsonObject | null> = async (request) => ({ id: request.id })) {}
  async agent(request: NormalizedAgentRequest, batch: import("../../src/runtime/workflow-host").ExecutionBatch): Promise<JsonObject | null> {
    this.agents.push(request);
    this.batches.push(batch);
    return this.respond(request);
  }
  phase(title: string): import("../../src/runtime/workflow-host").PhaseVisit { this.phases.push(title); return { executionAttemptId: 1, phaseVisitId: this.phases.length, title, occurrence: this.phases.filter((value) => value === title).length }; }
  log(message: string): void { this.logs.push(message); }
}

function workflow<Result>(run: () => Promise<Result>): WorkflowModule<undefined, Result> {
  return { meta, default: async () => run() };
}

describe("Workflow 作者 API", () => {
  test("仅能在 Workflow 执行上下文中调用", async () => {
    expect(() => agent("outside", { id: "outside", cli: "codex" })).toThrow("只能在正在执行的 Workflow 内");
    expect(() => phase("scan")).toThrow("只能在正在执行的 Workflow 内");
  });

  test("规范化 agent 请求、跟踪阶段并委派日志", async () => {
    const host = new MemoryHost();
    const result = await executeWorkflow(workflow(async () => {
      phase("scan");
      log("starting scan");
      return agent("Review src", { id: "scan:src", cli: "codex", input: { target: "src" } });
    }), undefined, host);

    expect(result).toEqual({ id: "scan:src" });
    expect(host.phases).toEqual(["scan"]);
    expect(host.logs).toEqual(["starting scan"]);
    expect(host.agents).toEqual([{
      id: "scan:src", cli: "codex", cwd: process.cwd(), input: { target: "src" }, prompt: "Review src", sandbox: "read-only", phase: "scan",
    }]);
  });

  test("拒绝非法 Agent 选项、重复 id 与未声明阶段", async () => {
    const host = new MemoryHost();
    await expect(executeWorkflow(workflow(async () => agent("", { id: "bad", cli: "codex" })), undefined, host)).rejects.toThrow("非空字符串");
    await expect(executeWorkflow(workflow(async () => agent("unsupported", { id: "unsupported", cli: "traex" as never })), undefined, host)).rejects.toThrow("当前仅支持 codex");
    await expect(executeWorkflow(workflow(async () => phase("missing")), undefined, host)).rejects.toThrow("已声明的阶段");
    await expect(executeWorkflow(workflow(async () => {
      await agent("one", { id: "same", cli: "codex" });
      return agent("two", { id: "same", cli: "codex" });
    }), undefined, host)).rejects.toThrow("必须唯一");
    await expect(executeWorkflow(workflow(async () => agent("schema", {
      id: "invalid-schema", cli: "codex", schema: { invalid: undefined } as unknown as Record<string, never>,
    })), undefined, host)).rejects.toThrow("schema 必须是 JSON-safe 对象");
  });

  test("隔离并发 Workflow Run 的当前阶段与宿主", async () => {
    const left = new MemoryHost();
    const right = new MemoryHost();
    await Promise.all([
      executeWorkflow(workflow(async () => { phase("scan"); return agent("left", { id: "left", cli: "codex" }); }), undefined, left),
      executeWorkflow(workflow(async () => { phase("summarize"); return agent("right", { id: "right", cli: "codex" }); }), undefined, right),
    ]);
    expect(left.agents[0].phase).toBe("scan");
    expect(right.agents[0].phase).toBe("summarize");
    expect(left.agents[0].id).toBe("left");
    expect(right.agents[0].id).toBe("right");
  });

  test("agent() 在异步 cwd 解析前冻结当前阶段访问，后续 phase 不得重归类已调用节点", async () => {
    const host = new MemoryHost();
    const directory = await mkdtemp(join(tmpdir(), "wave-flow-phase-capture-"));
    try {
      await executeWorkflow(workflow(async () => {
        phase("scan");
        const first = agent("first", { id: "first", cli: "codex", cwd: directory });
        phase("summarize");
        await first;
        return agent("second", { id: "second", cli: "codex", cwd: directory });
      }), undefined, host, { cwd: directory });
      expect(host.agents.map((request) => ({ id: request.id, phase: request.phase }))).toEqual([{ id: "first", phase: "scan" }, { id: "second", phase: "summarize" }]);
      expect(host.batches.map((batch) => batch.sequence)).toEqual([1, 2]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("parallel 同时启动任务、保持输入顺序并隔离失败", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const result = await executeWorkflow(workflow(async () => {
      const running = parallel([
        async () => { started.push("first"); await first; return "one"; },
        async () => { started.push("second"); throw new Error("expected"); },
        async () => { started.push("third"); return "three"; },
      ]);
      await Promise.resolve();
      expect(started).toEqual(["first", "second", "third"]);
      releaseFirst?.();
      return running;
    }), undefined, new MemoryHost());
    expect(result).toEqual(["one", null, "three"]);
  });

  test("顺序调用、parallel 与 pipeline 将真实调度域传给宿主", async () => {
    const host = new MemoryHost();
    await executeWorkflow(workflow(async () => {
      phase("scan");
      await agent("first", { id: "first", cli: "codex" });
      await parallel([
        () => agent("left", { id: "left", cli: "codex" }),
        () => agent("right", { id: "right", cli: "codex" }),
      ]);
      await pipeline(["a", "b"],
        async (item) => { await agent(`prepare ${item}`, { id: `prepare-${item}`, cli: "codex" }); return item; },
        async (item) => { await agent(`finish ${item}`, { id: `finish-${item as string}`, cli: "codex" }); return item; },
      );
      return agent("last", { id: "last", cli: "codex" });
    }), undefined, host);
    expect(host.agents.map((item) => item.id)).toEqual(["first", "left", "right", "prepare-a", "prepare-b", "finish-a", "finish-b", "last"]);
    expect(host.batches).toEqual([
      { sequence: 1, mode: "serial" },
      { sequence: 2, mode: "parallel" }, { sequence: 2, mode: "parallel" },
      { sequence: 3, mode: "parallel" }, { sequence: 3, mode: "parallel" },
      { sequence: 4, mode: "parallel" }, { sequence: 4, mode: "parallel" },
      { sequence: 5, mode: "serial" },
    ]);
  });

  test("pipeline 对每个 item 串行、跨 item 并行，并跳过失败 item 的后续 stage", async () => {
    const events: string[] = [];
    const result = await executeWorkflow(workflow(async () => pipeline([1, 2, 3],
      async (value) => { const numberValue = value as number; events.push(`a${numberValue}`); if (numberValue === 2) throw new Error("stop"); return numberValue + 10; },
      async (value) => { const numberValue = value as number; events.push(`b${numberValue}`); return numberValue * 2; },
    )), undefined, new MemoryHost());
    expect(result).toEqual([22, null, 26]);
    expect(events).toContain("a1");
    expect(events).toContain("a2");
    expect(events).toContain("a3");
    expect(events).not.toContain("b2");
  });

  test("在 parallel 或 pipeline 的并发范围内拒绝切换阶段", async () => {
    const host = new MemoryHost();
    await expect(executeWorkflow(workflow(() => parallel([async () => phase("scan")])), undefined, host)).rejects.toThrow("不能在 parallel");
    await expect(executeWorkflow(workflow(() => pipeline(["item"], async () => phase("scan"))), undefined, host)).rejects.toThrow("不能在 parallel");
    expect(host.phases).toEqual([]);
  });

  test("不会将 parallel 内的重复 Agent id 降级为业务 null", async () => {
    const host = new MemoryHost();
    await expect(executeWorkflow(workflow(() => parallel([
      () => agent("one", { id: "same", cli: "codex" }),
      () => agent("two", { id: "same", cli: "codex" }),
    ])), undefined, host)).rejects.toThrow("必须唯一");
    expect(host.agents).toHaveLength(1);
  });

  test("拒绝 Workflow 返回后其内部 timer 回调调用作者 API", async () => {
    const host = new MemoryHost();
    let delayedError: unknown;
    let notifyTimer: (() => void) | undefined;
    const timerRan = new Promise<void>((resolve) => { notifyTimer = resolve; });
    await executeWorkflow(workflow(async () => {
      setTimeout(() => {
        try {
          phase("scan");
        } catch (error) {
          delayedError = error;
        } finally {
          notifyTimer?.();
        }
      }, 0);
    }), undefined, host);
    await timerRan;
    expect(delayedError).toBeInstanceOf(Error);
    expect((delayedError as Error).message).toContain("Workflow 结束后");
    expect(host.agents).toEqual([]);
  });

  test("默认使用项目 cwd，允许显式绝对的独立 Agent cwd，拒绝越界相对路径", async () => {
    const project = await mkdtemp(join(tmpdir(), "wave-flow-project-"));
    const child = join(project, "frontend");
    const external = await mkdtemp(join(tmpdir(), "wave-flow-external-"));
    await Bun.$`mkdir -p ${child}`;
    try {
      const host = new MemoryHost();
      await executeWorkflow(workflow(async () => {
        phase("scan");
        await agent("default", { id: "default", cli: "codex" });
        await agent("child", { id: "child", cli: "codex", cwd: "frontend" });
        return agent("external", { id: "external", cli: "codex", cwd: external });
      }), undefined, host, { cwd: project });
      expect(host.agents.map((item) => item.cwd)).toEqual([await realpath(project), await realpath(child), await realpath(external)]);
      await expect(executeWorkflow(workflow(() => agent("outside", { id: "outside-cwd", cli: "codex", cwd: ".." })), undefined, new MemoryHost(), { cwd: project })).rejects.toThrow("相对 cwd 必须位于");
      expect(resolve(external)).toBe(external);
    } finally {
      await Promise.all([rm(project, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]);
    }
  });

  test("拒绝将普通文件作为 Run cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wave-flow-cwd-"));
    const file = join(directory, "not-a-directory");
    await writeFile(file, "x", "utf8");
    try {
      await expect(executeWorkflow(workflow(() => agent("test", { id: "cwd-file", cli: "codex" })), undefined, new MemoryHost(), { cwd: file })).rejects.toThrow("cwd 必须是目录");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
