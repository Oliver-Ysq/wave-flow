import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type AgentStatus = "queued" | "running" | "blocked" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";
type RunStatus = "running" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";
type Agent = { id: string; label: string; cli: "codex"; status: AgentStatus; cwd: string; result: Record<string, unknown> | null; diagnostic: string | null; block: { blockRequestId: string; needHelp: string; answered: boolean } | null };
type Batch = { sequence: number; mode: "serial" | "parallel"; agents: Agent[] };
type Visit = { executionAttemptId: number; phaseVisitId: number; title: string; occurrence: number; batches: Batch[]; createdAt: string };
type Run = { runId: string; snapshot: { id: string; status: RunStatus; workflow: { name: string; description: string }; cwd: string; createdAt: string; endedAt: string | null; diagnostic: string | null; phases: Array<{ title: string; agents: Agent[]; batches: Batch[] }> }; visits: Visit[] };

const now = "2026-10-06T11:20:00.000Z";
const agent = (id: string, status: AgentStatus, overrides: Partial<Agent> = {}): Agent => ({
  id,
  label: id,
  cli: "codex",
  status,
  cwd: "/Users/bytedance/Desktop/ai-project/wave-flow",
  result: null,
  diagnostic: null,
  block: null,
  ...overrides,
});
const phaseProjection = (visits: Visit[]) => [...new Set(visits.map((visit) => visit.title))].map((title) => {
  const phaseVisits = visits.filter((visit) => visit.title === title);
  return { title, agents: phaseVisits.flatMap((visit) => visit.batches.flatMap((batch) => batch.agents)), batches: phaseVisits.flatMap((visit) => visit.batches) };
});
const run = (id: string, status: RunStatus, name: string, description: string, visits: Visit[], overrides: Partial<Run["snapshot"]> = {}): Run => ({
  runId: id,
  snapshot: { id, status, workflow: { name, description }, cwd: "/Users/bytedance/Desktop/ai-project/wave-flow", createdAt: now, endedAt: null, diagnostic: null, phases: phaseProjection(visits), ...overrides },
  visits,
});

/** 仅供 Vite 开发服务器展示全部状态；不会进入生产 bundle 或 daemon。 */
const demoRuns: Run[] = [
  run("demo-blocked", "running", "checkout-recovery", "需要确认恢复策略后才能继续修改。", [
    {
      executionAttemptId: 1, phaseVisitId: 1, title: "环境确认", occurrence: 1, createdAt: now,
      batches: [{ sequence: 1, mode: "serial", agents: [agent("environment-check", "completed", { diagnostic: "已确认项目目录、依赖和 daemon 状态。" })] }],
    },
    {
      executionAttemptId: 1, phaseVisitId: 2, title: "检查", occurrence: 1, createdAt: now,
      batches: [
        { sequence: 2, mode: "parallel", agents: [
          agent("dependency-audit", "completed", { result: { checked: 18, warnings: 2 }, diagnostic: "依赖扫描已完成，发现两个需要人工确认的升级项。" }),
          agent("migration-owner", "blocked", { diagnostic: "需要确认是否允许迁移旧锁文件。", block: { blockRequestId: "demo-block-request", needHelp: "旧 daemon 的锁文件仍存在。请确认：是否允许在完成身份核验后迁移并继续？", answered: false } }),
        ] },
        { sequence: 3, mode: "serial", agents: [agent("recovery-report", "queued", { diagnostic: "等待前一批完成后汇总恢复结论。" })] },
      ],
    },
    { executionAttemptId: 1, phaseVisitId: 3, title: "汇总", occurrence: 1, createdAt: now, batches: [] },
  ]),
  run("demo-running", "running", "release-readiness", "运行中的多阶段发布检查。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "验证", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "parallel", agents: [
    agent("test-runner", "running", { diagnostic: "正在执行集成测试，预计还需检查 12 个场景。" }),
    agent("docs-checker", "queued", { diagnostic: "等待测试结果后开始文档校验。" }),
  ] }] }]),
  run("demo-density", "running", "parallel-release-train", "高密度并行批次，用于检查标签视图与完整阅读。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "发布准备", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "parallel", agents: [
    agent("lint-owner", "completed", { diagnostic: "静态检查已完成。" }),
    agent("unit-test-owner", "running", { diagnostic: "正在运行单元测试。" }),
    agent("integration-owner", "blocked", { diagnostic: "等待测试环境确认。", block: { blockRequestId: "demo-density-block", needHelp: "测试环境缺少依赖服务，请确认是否使用本地替代服务。", answered: false } }),
    agent("bundle-owner", "queued", { diagnostic: "等待构建名额。" }),
    agent("security-owner", "paused", { diagnostic: "安全扫描已暂停。" }),
    agent("release-note-owner", "interrupted", { diagnostic: "远端变更记录暂不可读取。" }),
  ] }] }]),
  run("demo-loop", "completed", "guess-analyze-loop", "真实多轮回溯：猜测、分析、再猜测。", [
      { executionAttemptId: 1, phaseVisitId: 1, title: "猜测", occurrence: 1, batches: [{ sequence: 1, mode: "serial", agents: [agent("guess-round-1", "completed", { diagnostic: "第一轮猜测已完成。" })] }], createdAt: now },
      { executionAttemptId: 1, phaseVisitId: 2, title: "分析", occurrence: 1, batches: [{ sequence: 2, mode: "parallel", agents: [agent("analyze-code-1", "completed"), agent("analyze-test-1", "completed")] }], createdAt: now },
      { executionAttemptId: 1, phaseVisitId: 3, title: "猜测", occurrence: 2, batches: [{ sequence: 3, mode: "serial", agents: [agent("guess-round-2", "completed", { diagnostic: "第二轮猜测已根据分析修正。" })] }], createdAt: now },
    ],
  ),
  run("demo-pausing", "pausing", "long-task-pause", "正在停止当前回合并清理受管工具。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "实现", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "serial", agents: [agent("implementation-agent", "pausing", { diagnostic: "正在中断当前回合，等待背景终端清理完成。" })] }] }]),
  run("demo-paused", "paused", "design-review", "现场已保留，等待恢复执行。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "审查", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "serial", agents: [agent("review-agent", "paused", { diagnostic: "已暂停，恢复后会在同一会话检查现场再继续。" })] }] }]),
  run("demo-recovering", "recovering", "resume-workspace", "正在恢复同一会话中的下一回合。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "恢复", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "serial", agents: [agent("workspace-agent", "recovering", { diagnostic: "正在创建检查现场后的继续回合。" })] }] }]),
  run("demo-completed", "completed", "api-contract-review", "接口契约与结构化结果已交付。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "交付", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "serial", agents: [agent("contract-reviewer", "completed", { result: { compatible: true, changedEndpoints: ["/daemon/close"] }, diagnostic: "已完成契约审查并写入结构化结果。" })] }] }], { endedAt: "2026-10-06T11:12:00.000Z" }),
  run("demo-cancelled", "cancelled", "experimental-refactor", "用户已停止本次实验性改造。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "实验", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "serial", agents: [agent("refactor-agent", "cancelled", { diagnostic: "用户停止了当前 Run，未继续调度下游节点。" })] }] }], { endedAt: "2026-10-06T11:05:00.000Z" }),
  run("demo-interrupted", "interrupted", "remote-check", "会话状态无法验证，需要用户显式重新执行。", [{ executionAttemptId: 1, phaseVisitId: 1, title: "远端检查", occurrence: 1, createdAt: now, batches: [{ sequence: 1, mode: "serial", agents: [agent("remote-agent", "interrupted", { diagnostic: "App Server 连接丢失，未自动重试以避免重复副作用。" })] }] }], { endedAt: "2026-10-06T10:58:00.000Z" }),
];

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function responseFor(id: string): Run | undefined { return demoRuns.find((item) => item.runId === id); }

function visitsFor(item: Run) {
  return item.visits;
}

function currentAttemptFor(item: Run) {
  const visits = visitsFor(item);
  return { runId: item.runId, status: item.snapshot.status, summary: { executionAttemptId: 1, latestPhaseVisitId: visits.at(-1)?.phaseVisitId ?? null, phases: item.snapshot.phases.map((phase) => {
    const phaseVisits = visits.filter((visit) => visit.title === phase.title);
    const agents = phaseVisits.flatMap((visit) => visit.batches.flatMap((batch) => batch.agents));
    const statusCounts = agents.reduce((counts, node) => ({ ...counts, [node.status]: (counts[node.status] ?? 0) + 1 }), {} as Partial<Record<AgentStatus, number>>);
    const latestVisitId = phaseVisits.findLast((visit) => visit.batches.some((batch) => batch.agents.length > 0))?.phaseVisitId ?? null;
    const currentVisitId = phaseVisits.findLast((visit) => visit.batches.some((batch) => batch.agents.some((node) => ["running", "blocked", "queued", "pausing", "paused", "recovering"].includes(node.status))))?.phaseVisitId ?? null;
    return { title: phase.title, visits: phaseVisits.length, agents: agents.length, statusCounts, currentVisitId, latestVisitId };
  }) } };
}

function listItemFor(item: Run) {
  const summary = currentAttemptFor(item).summary;
  return { runId: item.runId, workflow: item.snapshot.workflow, status: item.snapshot.status, cwd: item.snapshot.cwd, createdAt: item.snapshot.createdAt, endedAt: item.snapshot.endedAt, diagnostic: item.snapshot.diagnostic, hasBlockedAgent: summary.phases.some((phase) => (phase.statusCounts.blocked ?? 0) > 0) };
}

function updateRun(id: string, action: "pause" | "recover" | "stop" | "resume"): Run | undefined {
  const item = responseFor(id);
  if (!item) return undefined;
  const status: RunStatus = action === "pause" ? "paused" : action === "recover" ? "running" : action === "stop" ? "cancelled" : "running";
  item.snapshot.status = status;
  item.snapshot.endedAt = status === "cancelled" ? new Date().toISOString() : null;
  for (const phase of item.snapshot.phases) for (const node of phase.agents) {
    if (action === "pause" && ["running", "blocked", "queued"].includes(node.status)) node.status = "paused";
    if ((action === "recover" || action === "resume") && node.status === "paused") node.status = "running";
    if (action === "stop" && !["completed", "cancelled", "interrupted"].includes(node.status)) node.status = "cancelled";
  }
  return item;
}

/** 为 `web:dev` 提供覆盖所有页面状态的内存 API。 */
export function demoApiPlugin(): Plugin {
  return {
    name: "wave-flow-demo-api",
    configureServer(server) {
      server.middlewares.use((request: IncomingMessage, response: ServerResponse, next) => {
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (request.method === "GET" && path === "/api/runs") return json(response, structuredClone(demoRuns.map(listItemFor)));
        const currentAttempt = path.match(/^\/runs\/([^/]+)\/attempts\/current$/);
        if (request.method === "GET" && currentAttempt) {
          const item = responseFor(decodeURIComponent(currentAttempt[1]));
          return item ? json(response, currentAttemptFor(item)) : json(response, { error: "找不到演示 Run。" }, 404);
        }
        const attempts = path.match(/^\/runs\/([^/]+)\/attempts$/);
        if (request.method === "GET" && attempts) {
          const item = responseFor(decodeURIComponent(attempts[1]));
          return item ? json(response, { runId: item.runId, currentExecutionAttemptId: 1, executionAttemptIds: [1] }) : json(response, { error: "找不到演示 Run。" }, 404);
        }
        const phaseVisit = path.match(/^\/runs\/([^/]+)\/phase-visits\/(\d+)$/);
        if (request.method === "GET" && phaseVisit) {
          const item = responseFor(decodeURIComponent(phaseVisit[1])); const visit = item && visitsFor(item).find((candidate) => candidate.phaseVisitId === Number(phaseVisit[2]));
          return visit ? json(response, { runId: item!.runId, executionAttemptId: 1, visit }) : json(response, { error: "找不到演示阶段轮次。" }, 404);
        }
        const phaseVisits = path.match(/^\/runs\/([^/]+)\/phase-visits$/);
        if (request.method === "GET" && phaseVisits) {
          const item = responseFor(decodeURIComponent(phaseVisits[1]));
          if (!item) return json(response, { error: "找不到演示 Run。" }, 404);
          const cursor = Number(new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("cursor") ?? "0");
          const items = visitsFor(item).filter((visit) => visit.phaseVisitId > cursor);
          return json(response, { runId: item.runId, executionAttemptId: 1, items, nextCursor: null });
        }
        const control = path.match(/^\/runs\/([^/]+)\/(pause|recover|stop|resume)$/);
        if (request.method === "POST" && control) {
          const updated = updateRun(decodeURIComponent(control[1]), control[2] as "pause" | "recover" | "stop" | "resume");
          return updated ? json(response, structuredClone(updated)) : json(response, { error: "找不到演示 Run。" }, 404);
        }
        const answer = path.match(/^\/blocks\/([^/]+)\/answer$/);
        if (request.method === "POST" && answer) {
          for (const item of demoRuns) for (const phase of item.snapshot.phases) for (const node of phase.agents) {
            if (node.block?.blockRequestId === decodeURIComponent(answer[1])) {
              node.block.answered = true;
              node.diagnostic = "演示答案已交付，等待 Agent continue。";
              return json(response, { delivered: true });
            }
          }
          return json(response, { error: "找不到演示 block。" }, 404);
        }
        next();
      });
    },
  };
}
