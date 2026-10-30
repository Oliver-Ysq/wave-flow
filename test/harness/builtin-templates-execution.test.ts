import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { executeWorkflow } from "../../src/workflow/execute-workflow";
import { loadWorkflowSource } from "../../src/workflow/load-workflow";
import { listWorkflowTemplates } from "../../src/harness/workflow-templates";
import type { DecisionGateRequest, ExecutionBatch, PhaseVisit, WorkflowExecutionHost } from "../../src/runtime/workflow-host";
import type { JsonObject } from "../../src/shared/json";
import type { AuthorAgentRequest } from "../../src/shared/workflow-types";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * 假宿主：按节点 id 返回样例结果，并记录阶段、并发批次与决策门。
 * 桩结果必须通过脚本为该节点声明的 Schema 校验：否则真实 Worker 的 complete 结果
 * 会被 Control Server 拒绝，而这种契约错误在假宿主里不会暴露。
 */
class ScriptedHost implements WorkflowExecutionHost {
  readonly agents: AuthorAgentRequest[] = [];
  readonly phases: string[] = [];
  readonly gates: DecisionGateRequest[] = [];
  readonly agentBatches = new Map<string, ExecutionBatch>();
  constructor(private readonly respond: (request: AuthorAgentRequest) => JsonObject | null, private readonly answer: JsonObject = { approved: true, adjustments: "" }) {}
  async agent(request: AuthorAgentRequest, batch: ExecutionBatch): Promise<JsonObject | null> {
    this.agents.push(request);
    this.agentBatches.set(request.id, batch);
    const result = this.respond(request);
    if (result !== null && request.schema !== undefined) {
      const validate = ajv.compile(request.schema);
      if (!validate(result)) throw new Error(`桩结果不满足节点 ${request.id} 的 Schema：${ajv.errorsText(validate.errors)}`);
    }
    return result;
  }
  phase(title: string): PhaseVisit { this.phases.push(title); return { executionAttemptId: 1, phaseVisitId: this.phases.length, title, occurrence: 1 }; }
  log(): void {}
  async decisionGate(request: DecisionGateRequest): Promise<JsonObject> { this.gates.push(request); return this.answer; }
}

const finding = { title: "越界读", severity: "high", confidence: "high", file: "src/a.ts", lines: "10-14", evidence: "const x = arr[i]", trigger: "i 越界", impact: "崩溃", suggestion: "加边界判断" };
const researchFinding = { claim: "框架 A 更快", evidence: [{ title: "Bench", url: "https://example.com/bench", excerpt: "A 2x" }], confidence: "high", asOf: "2026-01" };

const researchRespond = (request: AuthorAgentRequest): JsonObject | null => {
  const id = request.id;
  if (id === "planner" || id === "planner-revised") return { brief: "研究简报", questions: [{ title: "问题一", keyPoints: ["要点"], searchHints: ["kw"] }, { title: "问题二", keyPoints: ["要点"], searchHints: ["kw"] }], controversies: ["争议"] };
  if (id.startsWith("research-")) return { findings: [researchFinding], gaps: [], failedSources: [] };
  if (id.startsWith("verify-")) return { verified: [researchFinding], rejected: [{ claim: "假结论", reason: "无依据" }], corrections: [] };
  if (id === "cross-check") return { claims: [{ claim: "框架 A 更快", confidence: "high", sourceFamilyCount: 2, contradictions: [] }], gaps: ["缺少基准条件"], summary: "整体一致" };
  if (id === "synthesizer") return { report: "# 报告\n结论 [1]", citations: [{ id: "1", title: "Bench", url: "https://example.com/bench" }], keyTakeaways: ["A 更快"] };
  if (id === "critic") return { issues: [{ severity: "major", target: "结论 1", problem: "单来源", fix: "补充来源" }], verdict: "revise", assessment: "需修订" };
  if (id === "reviser") return { report: "# 最终报告\n结论 [1] 已修订", citations: [{ id: "1", title: "Bench", url: "https://example.com/bench" }], keyTakeaways: ["A 更快（已补充来源）"], changesMade: ["补充来源说明"], remainingLimitations: ["未覆盖 Y"] };
  return null;
};

const reviewRespond = (request: AuthorAgentRequest): JsonObject | null => {
  const id = request.id;
  if (id === "scope-mapper") return { intentSummary: "引入任务队列", reviewSurface: [{ path: "src/queue.ts", reason: "核心逻辑" }], changeSurface: ["src/queue.ts"], standards: ["必须幂等"], riskAreas: ["并发"], testNotes: ["测试在 test/queue.test.ts"] };
  if (id.startsWith("review-")) return { findings: [finding], coverage: ["src/queue.ts"] };
  if (id.startsWith("verify-")) return { confirmed: [finding], rejected: [{ title: "风格问题", reason: "lint 能抓" }], notes: ["已复核"] };
  if (id === "judge") return { findings: [finding], mergeRecommendation: "changes_required", summary: "存在高危问题" };
  if (id === "blind-spot") return { blindSpots: [{ path: "src/worker.ts", reason: "高风险但无发现", suggestedCheck: "检查重试" }], statement: "有一处盲区" };
  if (id === "report-writer") return { report: "# 审查报告", stats: { confirmed: 1, rejected: 1, dimensions: 6 } };
  return null;
};

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-builtin-"));
  directories.push(cwd);
  // 深度CR 把 target 作为各 Worker 的 cwd，宿主要求该目录真实存在。
  await mkdir(join(cwd, "src"), { recursive: true });
  return cwd;
}

test("深度调研：计划确认、并行调研、逐条核验、缺口补证与红队修订全链路执行", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(researchRespond);
  const result = await executeWorkflow(module, { topic: "端侧推理框架", depth: "deep", questions: ["怎么选"], context: "", language: "中文" }, host, { cwd: await workspace() }) as { report: string; stats: Record<string, number> };
  expect(host.gates).toHaveLength(1);
  expect(host.gates[0]!.id).toBe("approve-research-plan");
  expect(host.gates[0]!.answerSchema).toMatchObject({ required: ["approved", "adjustments"] });
  expect(host.phases).toEqual(["计划", "调研", "核验", "交叉检查与补证", "综评", "批判", "定稿"]);
  const ids = host.agents.map(request => request.id);
  expect(ids).toContain("planner");
  expect(ids).toContain("cross-check");
  expect(ids).toContain("synthesizer");
  expect(ids).toContain("critic");
  expect(ids).toContain("reviser");
  expect(ids.filter(id => id.startsWith("research-r1-"))).toHaveLength(2);
  expect(ids.filter(id => id.startsWith("verify-r1-"))).toHaveLength(2);
  expect(ids.filter(id => id.startsWith("research-r2-"))).toHaveLength(1);
  expect(ids.filter(id => id.startsWith("verify-r2-"))).toHaveLength(1);
  expect(new Set(ids).size).toBe(ids.length);
  // 受限草案的资源护栏：单次 Run 的 agent 总数不得超过 20。
  expect(ids.length).toBeLessThanOrEqual(20);
  expect(result.report).toContain("已修订");
  // 两轮核验各剔除一条误报：V1 两批 + V2 一批。
  expect(result.stats.rejectedFindings).toBe(3);
  expect(result.stats.round2Questions).toBe(1);
  expect(result.stats.round1Succeeded).toBe(2);
});

test("深度调研：standard 深度不触发第二轮补证，节点数更少", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(researchRespond);
  await executeWorkflow(module, { topic: "端侧推理框架", depth: "standard" }, host, { cwd: await workspace() });
  const ids = host.agents.map(request => request.id);
  expect(ids.filter(id => id.startsWith("research-r2-"))).toHaveLength(0);
  expect(ids.length).toBeLessThanOrEqual(20);
});

test("深度调研：standard 模式也把交叉检查的缺口列入未解决问题", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id === "cross-check"
    ? { claims: [], gaps: ["缺少统一基准条件"], summary: "一处缺口" }
    : researchRespond(request));
  await executeWorkflow(module, { topic: "端侧推理框架", depth: "standard" }, host, { cwd: await workspace() });
  const synth = host.agents.find(request => request.id === "synthesizer")!;
  expect(synth.prompt).toContain("unresolvedGaps");
  expect(synth.prompt).toContain("缺少统一基准条件");
  expect(host.agents.some(request => request.id.startsWith("research-r2-"))).toBe(false);
});

test("深度调研：计划被否决且无调整说明时立即失败，不消耗调研预算", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(researchRespond, { approved: false, adjustments: "  " });
  await expect(executeWorkflow(module, { topic: "端侧推理框架" }, host, { cwd: await workspace() })).rejects.toThrow("未获批准");
  expect(host.agents.map(request => request.id)).toEqual(["planner"]);
});

test("深度调研：用户给出调整时重新出计划再继续调研", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(researchRespond, { approved: false, adjustments: "只研究基准测试" });
  await executeWorkflow(module, { topic: "端侧推理框架", depth: "standard" }, host, { cwd: await workspace() });
  const ids = host.agents.map(request => request.id);
  expect(ids[0]).toBe("planner");
  expect(ids[1]).toBe("planner-revised");
  expect(ids.filter(id => id.startsWith("research-r1-"))).toHaveLength(2);
});

test("深度调研：调研节点失败时继续用其余结果，不产出空报告", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  let calls = 0;
  const host = new ScriptedHost(request => {
    calls += 1;
    if (request.id.startsWith("research-") && calls === 3) return null;
    return researchRespond(request);
  });
  const result = await executeWorkflow(module, { topic: "端侧推理框架", depth: "standard" }, host, { cwd: await workspace() }) as { stats: Record<string, number> };
  expect(result.stats.round1Attempted).toBe(2);
  expect(result.stats.round1Succeeded).toBe(1);
  expect(result.stats.verifiedFindings).toBe(1);
  // 没调研成的问题必须显式交给撰写人和红队，不能从报告里悄悄消失。
  const synth = host.agents.find(request => request.id === "synthesizer")!;
  expect(synth.prompt).toContain("unresearchedQuestions");
  expect(synth.prompt).toContain("问题二");
  const critic = host.agents.find(request => request.id === "critic")!;
  expect(critic.prompt).toContain("未调研成功的问题");
});

test("深度调研：全部调研失败时以明确错误收敛", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id.startsWith("research-") ? null : researchRespond(request));
  await expect(executeWorkflow(module, { topic: "端侧推理框架" }, host, { cwd: await workspace() })).rejects.toThrow("没有任何可用结果");
});

test("深度调研：第二轮补证有个别失败时只核验成功批次，不重核第一轮结果", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => {
    if (request.id === "cross-check") return { claims: [], gaps: ["缺口一", "缺口二"], summary: "两处缺口" };
    if (request.id === "research-r2-1") return null;
    return researchRespond(request);
  });
  const result = await executeWorkflow(module, { topic: "端侧推理框架", depth: "deep" }, host, { cwd: await workspace() }) as { stats: Record<string, number> };
  const ids = host.agents.map(request => request.id);
  expect(ids.filter(id => id.startsWith("research-r2-"))).toHaveLength(2);
  expect(ids.filter(id => id.startsWith("verify-r2-"))).toHaveLength(1);
  // 第一轮的两个批次只核验一次，不能因为第二轮少一个成功批次而被重新核验。
  expect(ids.filter(id => id.startsWith("verify-r1-"))).toHaveLength(2);
  expect(result.stats.round2Succeeded).toBe(1);
  // 第一轮两个批次各 1 条，第二轮成功批次 1 条，合计 3 条已核验结论。
  expect(result.stats.verifiedFindings).toBe(3);
});

test("深度CR：复核节点全部失败时拒绝出报告，不把没查过说成没问题", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id.startsWith("verify-") ? null : reviewRespond(request));
  await expect(executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() })).rejects.toThrow("所有复核节点都未能交付");
  // 报告节点不得被调用：没有可信复核就没有可信报告。
  expect(host.agents.map(request => request.id)).not.toContain("report-writer");
});

test("深度CR：裁决节点失败时的回退建议仍按严重度判定", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id === "judge" ? null : reviewRespond(request));
  const result = await executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() }) as { mergeRecommendation: string };
  // 桩结果里存在 high 级发现，回退不得给出 needs_review。
  expect(result.mergeRecommendation).toBe("changes_required");
});

test("深度调研：红队节点未交付时如实说明缺少反向审查，不谎报通过", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id === "critic" ? null : researchRespond(request));
  const result = await executeWorkflow(module, { topic: "端侧推理框架", depth: "standard" }, host, { cwd: await workspace() }) as { stats: Record<string, unknown> };
  expect(result.stats.criticDelivered).toBe(false);
  expect(result.stats.criticIssues).toBe(0);
  expect(host.agents.map(request => request.id)).not.toContain("reviser");
});

test("内置预置全程只读：所有 Worker 都是 read-only 意图，不写业务文件", async () => {
  const research = listWorkflowTemplates().find(item => item.id === "deep-research")!;
  const researchHost = new ScriptedHost(researchRespond);
  await executeWorkflow(await loadWorkflowSource(research.source), { topic: "端侧推理框架", depth: "standard" }, researchHost, { cwd: await workspace() });
  const review = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const reviewHost = new ScriptedHost(reviewRespond);
  await executeWorkflow(await loadWorkflowSource(review.source), { target: "src" }, reviewHost, { cwd: await workspace() });
  const codeReview = listWorkflowTemplates().find(item => item.id === "code-review")!;
  const codeHost = new ScriptedHost(() => ({ findings: [], limitations: "夹具" }));
  await executeWorkflow(await loadWorkflowSource(codeReview.source), { target: "src", focus: ["安全"], maxFindings: 2 }, codeHost, { cwd: await workspace() });
  for (const host of [researchHost, reviewHost, codeHost]) {
    expect(host.agents.length).toBeGreaterThan(0);
    for (const request of host.agents) {
      expect(request.sandbox).toBe("read-only");
      expect(request.cli).toBeUndefined();
    }
  }
});

test("深度CR：摸底、六个专项并行审查、逐条取证复核、裁决、盲区与汇总全链路执行", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(reviewRespond);
  const result = await executeWorkflow(module, { target: "src", base: "main", focus: ["并发"], context: "", language: "中文" }, host, { cwd: await workspace() }) as { report: string; mergeRecommendation: string; stats: Record<string, number> };
  expect(host.gates).toHaveLength(0);
  expect(host.phases).toEqual(["摸底", "分维审查", "取证复核", "交叉裁决", "盲区扫描", "定稿汇总"]);
  const ids = host.agents.map(request => request.id);
  expect(ids).toEqual([
    "scope-mapper",
    "review-correctness", "review-security", "review-concurrency", "review-resilience", "review-compat", "review-intent",
    "verify-correctness", "verify-security", "verify-concurrency", "verify-resilience", "verify-compat", "verify-intent",
    "judge", "blind-spot", "report-writer",
  ]);
  expect(ids.length).toBeLessThanOrEqual(20);
  // 六个专项审查员必须真的在同一并发批次里，而不是被串行化。
  const reviewBatches = new Set(host.agents.filter(request => request.id.startsWith("review-")).map(request => host.agentBatches.get(request.id)));
  expect(reviewBatches.size).toBe(1);
  expect(result.mergeRecommendation).toBe("changes_required");
  expect(result.report).toContain("审查报告");
  expect(result.stats.confirmedFindings).toBe(6);
  expect(result.stats.rejectedFindings).toBe(6);
  // 所有节点必须在同一项目根运行，文件路径口径才一致（不得让部分节点用 target 作为 cwd）。
  expect(new Set(host.agents.map(request => request.cwd)).size).toBe(1);
  const reviewPrompt = host.agents.find(request => request.id === "review-security")!.prompt;
  expect(reviewPrompt).toContain("所有文件路径一律相对项目根目录书写");
  expect(reviewPrompt).toContain("审查范围是 src");
});

test("深度CR：某个维度审查失败时，其余维度的复核节点 id 仍与自己的维度对应", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id === "review-correctness" ? null : reviewRespond(request));
  await executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() });
  const ids = host.agents.map(request => request.id);
  expect(ids).toContain("review-security");
  expect(ids).not.toContain("verify-correctness");
  expect(ids.filter(id => id.startsWith("verify-"))).toEqual(["verify-security", "verify-concurrency", "verify-resilience", "verify-compat", "verify-intent"]);
});

test("深度CR：提供基线时专项审查员收到增量口径，未提供时收到全量口径", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const incremental = new ScriptedHost(reviewRespond);
  await executeWorkflow(module, { target: "src", base: "main", context: "引入任务队列" }, incremental, { cwd: await workspace() });
  const incrementalPrompt = incremental.agents.find(request => request.id === "review-concurrency")!.prompt;
  expect(incrementalPrompt).toContain("基线 main");
  expect(incrementalPrompt).toContain("只审该基线以来的改动");
  expect(incrementalPrompt).toContain("引入任务队列");
  // 增量模式：复核员必须剔除"非本次变更引入"的历史问题。
  const incrementalVerify = incremental.agents.find(request => request.id === "verify-concurrency")!.prompt;
  expect(incrementalVerify).toContain("既有的历史问题(非本次变更引入)");
  expect(incrementalVerify).not.toContain("无源码依据或问题不成立");

  const full = new ScriptedHost(reviewRespond);
  await executeWorkflow(module, { target: "src" }, full, { cwd: await workspace() });
  const fullPrompt = full.agents.find(request => request.id === "review-concurrency")!.prompt;
  expect(fullPrompt).toContain("按给定审查面做全量审查");
  // 全量审查必须明确包含历史遗留问题，否则"既有历史问题不报"会让审查员什么都不报。
  expect(fullPrompt).toContain("包括早于最近提交的历史遗留问题");
  // 全量模式：复核员不得再以"历史问题"剔除发现，否则会清空所有真实缺陷。
  const fullVerify = full.agents.find(request => request.id === "verify-concurrency")!.prompt;
  expect(fullVerify).toContain("无源码依据或问题不成立");
  expect(fullVerify).not.toContain("既有的历史问题(非本次变更引入)");
});

test("深度CR：所有专项审查失败时以明确错误收敛", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id.startsWith("review-") ? null : reviewRespond(request));
  await expect(executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() })).rejects.toThrow("所有专项审查都未能交付");
});

test("深度CR：复核全部否决时不产出确认发现，报告仍说明无确认问题", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id.startsWith("verify-") ? { confirmed: [], rejected: [{ title: "x", reason: "无依据" }], notes: [] } : reviewRespond(request));
  const result = await executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() }) as { stats: Record<string, number> };
  expect(result.stats.confirmedFindings).toBe(0);
});

test("深度CR：摸底返回范围外文件时剔除，全部在范围外则拒绝开工", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(request => request.id === "scope-mapper"
    ? { intentSummary: "混合范围", reviewSurface: [{ path: "./src/a.ts", reason: "核心" }, { path: "test/a.test.ts", reason: "测试" }], changeSurface: ["src/a.ts", "test/a.test.ts"], standards: [], riskAreas: [], testNotes: [] }
    : reviewRespond(request));
  await executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() });
  const reviewer = host.agents.find(request => request.id === "review-correctness")!;
  expect(reviewer.prompt).toContain("src/a.ts");
  // 范围外的文件既不能进审查清单，也不能出现在变更面里。
  expect(reviewer.prompt).not.toContain("test/a.test.ts");

  const outside = new ScriptedHost(request => request.id === "scope-mapper"
    ? { intentSummary: "全在范围外", reviewSurface: [{ path: "test/a.test.ts", reason: "测试" }], changeSurface: ["test/a.test.ts"], standards: [], riskAreas: [], testNotes: [] }
    : reviewRespond(request));
  await expect(executeWorkflow(module, { target: "src" }, outside, { cwd: await workspace() })).rejects.toThrow("可审查的文件");
});

test("深度CR：报告撰写人拿到完成审查的维度总数，不与失败核验混淆", async () => {
  const template = listWorkflowTemplates().find(item => item.id === "deep-cr")!;
  const module = await loadWorkflowSource(template.source);
  const host = new ScriptedHost(reviewRespond);
  await executeWorkflow(module, { target: "src" }, host, { cwd: await workspace() });
  const writer = host.agents.find(request => request.id === "report-writer")!;
  expect(writer.prompt).toContain("完成审查的维度总数：6");
  expect(writer.prompt).toContain("stats.dimensions 必须填写");
});
