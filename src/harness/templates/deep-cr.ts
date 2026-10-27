const meta = {
  name: "deep-cr",
  description: "多维度深度代码审查并逐条取证复核",
  phases: [{ title: "摸底" }, { title: "分维审查" }, { title: "取证复核" }, { title: "交叉裁决" }, { title: "盲区扫描" }, { title: "定稿汇总" }],
  exampleArgs: { target: "src/", base: "main", context: "本次变更引入任务队列" }
};
type Args = { target: string; base?: string; focus?: string[]; context?: string; language?: string };
type SurfaceFile = { path: string; reason: string };
type MapResult = { intentSummary: string; reviewSurface: SurfaceFile[]; changeSurface: string[]; standards: string[]; riskAreas: string[]; testNotes: string[] };
type Finding = { title: string; severity: string; confidence: string; file: string; lines: string; evidence: string; trigger: string; impact: string; suggestion: string };
type ReviewBatch = { findings: Finding[]; coverage: string[] };
type VerifyBatch = { confirmed: Finding[]; rejected: { title: string; reason: string }[]; notes: string[] };

async function run(args: Args) {
  const target = args.target;
  const language = typeof args.language === "string" && args.language.trim() !== "" ? args.language : "中文";
  const base = typeof args.base === "string" && args.base.trim() !== "" ? args.base : "";
  const focus = args.focus ? args.focus : [];
  const context = typeof args.context === "string" ? args.context : "";
  phase("摸底");
  log("正在摸底审查范围：变更面、模块结构、审查规范与高风险区域。");
  const mapSchema = { type: "object", properties: { intentSummary: { type: "string" }, reviewSurface: { type: "array", maxItems: 30, items: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" } }, required: ["path", "reason"], additionalProperties: false } }, changeSurface: { type: "array", maxItems: 40, items: { type: "string" } }, standards: { type: "array", maxItems: 8, items: { type: "string" } }, riskAreas: { type: "array", maxItems: 10, items: { type: "string" } }, testNotes: { type: "array", maxItems: 8, items: { type: "string" } } }, required: ["intentSummary", "reviewSurface", "changeSurface", "standards", "riskAreas", "testNotes"], additionalProperties: false };
  const mapPrompt = "你是一名审查协调员，只做摸底，不审查具体问题。任务：确定审查范围并输出结构化摸底结果。所有路径一律相对项目根目录书写。范围参数：" + JSON.stringify({ target: target, base: base, context: context }) + "。要求：1) 用只读 git 命令(如 git status、git diff、git log、git ls-files)确定变更面；提供了 base 时以 git diff <base>...HEAD 的变更文件为准，没有 base 时以工作区未提交变更为准，都没有则取 target 下的核心源文件；绝不运行构建、测试或任何写操作；2) intentSummary 用 2 到 4 句话说明这批变更的意图与机制(没有 diff 就根据代码结构与最近提交推断并注明是推断)；3) reviewSurface 给出最值得深入审查的最多 30 个文件及入选理由，优先：变更文件、高风险模块、入口与核心逻辑；4) standards 收集仓库内 AGENTS.md、CONTRIBUTING、README 中的审查相关约定要点，没有就空数组；5) riskAreas 指出本仓库的高风险区域(并发、资金、鉴权、数据迁移等)；6) testNotes 说明相关测试在哪、变更路径是否已有测试。最终以 JSON 返回。";
  const mapped = await agent(mapPrompt, { id: "scope-mapper", cli: "codex", label: "审查摸底", schema: mapSchema });
  if (!mapped) throw new Error("审查摸底未能交付。");
  const map = mapped as MapResult;
  // 摸底按全仓变更面列举，可能包含 target 之外的文件；审查规则要求不得越界读取，
  // 所以先按范围求交，避免"清单里有、规则说不许读"的自相矛盾。
  const normalizePath = (value: string): string => value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const targetRoot = normalizePath(target);
  const inTarget = (path: string): boolean => {
    const value = normalizePath(path);
    if (targetRoot === "" || targetRoot === ".") return true;
    return value === targetRoot || value.startsWith(targetRoot + "/");
  };
  const reviewSurface = map.reviewSurface.filter((item) => inTarget(item.path));
  const changeSurface = map.changeSurface.filter((path) => inTarget(path));
  const droppedSurface = map.reviewSurface.length - reviewSurface.length;
  if (droppedSurface > 0) log("摸底返回的 " + droppedSurface + " 个文件不在审查范围 " + target + " 内，已剔除。");
  if (reviewSurface.length === 0) throw new Error("摸底没有发现审查范围 " + target + " 内可审查的文件。");
  log("摸底完成：变更面 " + changeSurface.length + " 个文件，深入审查面 " + reviewSurface.length + " 个文件。");
  const surfaceText = reviewSurface.map((item) => item.path + "(" + item.reason + ")").join("；");
  const focusText = focus.length > 0 ? "用户特别关注的类别：" + JSON.stringify(focus) + "。" : "";
  const findingItem = { type: "object", properties: { title: { type: "string" }, severity: { type: "string", enum: ["critical", "high", "medium", "low"] }, confidence: { type: "string", enum: ["high", "medium", "low"] }, file: { type: "string" }, lines: { type: "string" }, evidence: { type: "string" }, trigger: { type: "string" }, impact: { type: "string" }, suggestion: { type: "string" } }, required: ["title", "severity", "confidence", "file", "lines", "evidence", "trigger", "impact", "suggestion"], additionalProperties: false };
  const reviewSchema = { type: "object", properties: { findings: { type: "array", maxItems: 8, items: findingItem }, coverage: { type: "array", maxItems: 30, items: { type: "string" } } }, required: ["findings", "coverage"], additionalProperties: false };
  const dimensions = [
    { id: "correctness", name: "正确性", checklist: "确定性 bug：边界条件、off-by-one、空值与未定义处理、类型误用、条件写反、错误的默认值、逻辑组合错误。先读上下文再下结论，禁止怀疑在别处定义的符号。" },
    { id: "security", name: "安全", checklist: "注入(SQL/命令/模板)、硬编码密钥或令牌、鉴权与访问控制遗漏、敏感数据写日志、不安全反序列化、SSRF、路径穿越、弱随机数用于安全场景、危险依赖用法。" },
    { id: "concurrency", name: "并发与状态", checklist: "竞态条件、死锁、共享可变状态、非线程安全单例、异步回调顺序假设、事务边界、幂等性、失败路径的状态一致性。" },
    { id: "resilience", name: "错误处理与资源", checklist: "错误被吞掉或只打印不处理、缺失超时、连接与句柄泄漏、重试无退避或风暴、异常路径资源未释放、清理逻辑缺失。" },
    { id: "compat", name: "接口与数据兼容", checklist: "API 或协议破坏性变更、schema 与数据迁移安全、配置兼容、序列化格式变化、迁移可回滚性、跨版本兼容。" },
    { id: "intent", name: "意图符合与测试", checklist: "对照用户给出的意图与推断的意图，检查变更是否实现了声明的目标、有无 scope creep 或半成品实现；变更行为路径是否被测试覆盖(测试文件只粗审断言正确性，不逐行审)；文档与代码是否一致。" }
  ];
  // 有基线才是增量审查（既有历史问题不报）；没有基线就是全量审查，历史遗留问题
  // 也必须报告，否则"既有历史问题不报"会被模型理解成"什么都不要报"。
  const scoped = base !== "";
  const scopeRule = scoped ? "本次提供了基线 " + base + "，只审该基线以来的改动：先看改动内容，再看必要的上下文，既有历史问题一律不报。" : "没有提供基线，按给定审查面做全量审查：审查面内所有有源码证据的问题都必须报告，包括早于最近提交的历史遗留问题；无法判断是否与最近提交相关时在 impact 中写 unknown。";
  const sharedRules = "通用规则：0) 所有文件路径一律相对项目根目录书写，审查范围是 " + target + "，不得读取该范围以外的文件；1) 只报有源码证据、能给出具体触发场景的问题，说不出触发场景的不报，不确定的不报，风格与 linter 能抓的问题不报；2) 每条发现必须给出 file(相对路径)、lines(行区间如 120-135)、evidence(相关代码摘录)、trigger(具体触发场景)、impact(后果)、suggestion(可执行修复建议)；3) 低置信度但高影响的发现可以报，必须在 impact 中显式注明不确定性；4) 只审查给定清单内的文件，不得越界；5) 报告中已确认的问题在 coverage 列出你实际审查过的文件。审查范围口径：" + scopeRule + "变更面文件（已按审查范围过滤）：" + JSON.stringify(changeSurface) + "。审查员推断的变更意图：" + map.intentSummary + "。用户给出的变更意图：" + (context.trim() === "" ? "（用户未提供）" : context) + "。审查规范要点：" + JSON.stringify(map.standards) + "。" + focusText;
  phase("分维审查");
  log("六个专项审查员并行审查不同维度：" + dimensions.map((dim) => dim.name).join("、"));
  const reviews = await parallel(dimensions.map((dim, index) => () => (async () => {
    log("- 开始" + dim.name + "审查");
    const prompt = "你是一名只读的 " + dim.name + " 审查员。审查清单：" + dim.checklist + sharedRules + "审查文件清单：" + surfaceText + "。最终以 JSON 返回 findings 与 coverage。";
    const result = await agent(prompt, { id: "review-" + dim.id, cli: "codex", label: dim.name + "审查", schema: reviewSchema });
    if (result) {
      const batch = result as ReviewBatch;
      log("- 完成" + dim.name + "审查，发现 " + batch.findings.length + " 个问题");
    } else {
      log("- " + dim.name + "审查失败");
    }
    return result as ReviewBatch | null;
  })()));
  const batches: { id: string; dim: string; batch: ReviewBatch }[] = [];
  dimensions.forEach((dim, index) => {
    const batch = reviews[index];
    if (batch !== null) batches.push({ id: dim.id, dim: dim.name, batch: batch });
  });
  if (batches.length === 0) throw new Error("所有专项审查都未能交付。");
  const verifySchema = { type: "object", properties: { confirmed: { type: "array", maxItems: 8, items: findingItem }, rejected: { type: "array", maxItems: 8, items: { type: "object", properties: { title: { type: "string" }, reason: { type: "string" } }, required: ["title", "reason"], additionalProperties: false } }, notes: { type: "array", maxItems: 5, items: { type: "string" } } }, required: ["confirmed", "rejected", "notes"], additionalProperties: false };
  phase("取证复核");
  log("独立复核员逐条打开源码核实每个发现，剔除误报。");
  const verifications = await parallel(batches.map((entry, index) => () => (async () => {
    log("- 开始复核" + entry.dim + "批次");
    const prompt = "你是一名取证复核员，独立复核 " + entry.dim + " 审查员提交的发现批次，只剔除有依据的误报，不新增发现。批次(JSON)：" + JSON.stringify(entry.batch.findings) + "。逐条处理：1) 重新打开 file 的 lines 区间核对 evidence 代码是否真实存在、问题是否成立；2) 剔除以下情况并在 rejected 给 reason：" + (scoped ? "既有的历史问题(非本次变更引入)、" : "无源码依据或问题不成立、") + "linter 能抓的问题、误读代码(符号在别处定义、上下文被截断导致的误判)、说不出触发场景的推测；3) 确认 severity 与 confidence 是否恰当，明显高估就下调；4) notes 记录你的复核方法与任何保留意见。最终以 JSON 返回 confirmed、rejected、notes。";
    const result = await agent(prompt, { id: "verify-" + entry.id, cli: "codex", label: "复核 " + entry.dim, schema: verifySchema });
    if (result) {
      const verdict = result as VerifyBatch;
      log("- 完成复核" + entry.dim + "：确认 " + verdict.confirmed.length + " 条，剔除 " + verdict.rejected.length + " 条");
    } else {
      log("- 复核" + entry.dim + "失败");
    }
    return result as VerifyBatch | null;
  })()));
  const confirmed: Finding[] = [];
  const confirmedWithDim: { dim: string; finding: Finding }[] = [];
  let rejectedCount = 0;
  let verificationFailures = 0;
  verifications.forEach((verdict, index) => {
    if (verdict === null) {
      verificationFailures = verificationFailures + 1;
      return;
    }
    const dim = batches[index]!.dim;
    verdict.confirmed.forEach((finding) => {
      confirmed.push(finding);
      confirmedWithDim.push({ dim: dim, finding: finding });
    });
    rejectedCount = rejectedCount + verdict.rejected.length;
  });
  // 复核节点全部失败时不能产出"未发现问题"的报告：那是没查过，不是没问题。
  if (verificationFailures === batches.length) throw new Error("所有复核节点都未能交付，无法给出可信的审查结论。");
  log("复核完成：确认 " + confirmed.length + " 条发现，剔除 " + rejectedCount + " 条误报。");
  if (verificationFailures > 0) log("注意：" + verificationFailures + " 个维度的复核节点未交付，其发现未计入本报告。");
  const judgeSchema = { type: "object", properties: { findings: { type: "array", maxItems: 20, items: findingItem }, mergeRecommendation: { type: "string", enum: ["no_concerns", "needs_review", "changes_required"] }, summary: { type: "string" } }, required: ["findings", "mergeRecommendation", "summary"], additionalProperties: false };
  phase("交叉裁决");
  const judged = await agent("你是裁决人，对所有已确认的发现做跨维度整理。输入发现(JSON，带维度来源)：" + JSON.stringify(confirmedWithDim) + "；变更意图：" + map.intentSummary + "。要求：1) 去重合并：同一 file 相邻行区间被多个维度命中的问题只保留一条并注明涉及维度；2) 按 severity(critical>high>medium>low)再按 confidence 排序；3) 没有确认发现时 mergeRecommendation 给 no_concerns，有 critical 或 high 给 changes_required，其余给 needs_review；4) summary 给 2 到 4 句整体判断。最终以 JSON 返回 findings、mergeRecommendation、summary。", { id: "judge", cli: "codex", label: "交叉裁决", schema: judgeSchema });
  phase("盲区扫描");
  const blindSchema = { type: "object", properties: { blindSpots: { type: "array", maxItems: 8, items: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" }, suggestedCheck: { type: "string" } }, required: ["path", "reason", "suggestedCheck"], additionalProperties: false } }, statement: { type: "string" } }, required: ["blindSpots", "statement"], additionalProperties: false };
  const blind = await agent("你是盲区扫描员。审查面与高风险区域(JSON)：" + JSON.stringify({ reviewSurface: reviewSurface, riskAreas: map.riskAreas }) + "；已确认发现覆盖的文件(JSON)：" + JSON.stringify(confirmed.map((finding) => finding.file)) + "。找出审查面与高风险区域中没有被任何已确认发现覆盖、又值得人工再看的文件或区域，给 reason 与 suggestedCheck；确实没有就明确说没有。最终以 JSON 返回 blindSpots、statement。", { id: "blind-spot", cli: "codex", label: "盲区扫描", schema: blindSchema });
  phase("定稿汇总");
  const finalSchema = { type: "object", properties: { report: { type: "string" }, stats: { type: "object", properties: { confirmed: { type: "integer" }, rejected: { type: "integer" }, dimensions: { type: "integer" } }, required: ["confirmed", "rejected", "dimensions"], additionalProperties: false } }, required: ["report", "stats"], additionalProperties: false };
  // 裁决节点失败时的回退必须沿用同一严重度规则，否则"没有 critical 就 needs_review"会漏掉高危结论。
  const fallbackRecommendation = confirmed.some((finding) => finding.severity === "critical" || finding.severity === "high") ? "changes_required" : confirmed.length > 0 ? "needs_review" : "no_concerns";
  const judgeValue = judged === null ? { findings: confirmed, mergeRecommendation: fallbackRecommendation, summary: "裁决节点未交付，按复核结果直接汇总。" } : judged;
  const blindValue = blind === null ? { blindSpots: [], statement: "盲区扫描未交付。" } : blind;
  const final = await agent("你是报告撰写人。基于以下输入撰写一份 " + language + " 深度代码审查报告(markdown)。结构：1) 变更走查(意图与机制)；2) 分级发现列表，每条格式为 [severity][confidence] file:lines title，正文含 evidence、trigger、impact、suggestion；3) 合并建议(no_concerns/needs_review/changes_required)与理由；4) 覆盖与局限：实际审查过的文件、盲区扫描建议人工复核项、failedVerifications 大于 0 时说明有多少维度未完成复核、本次审查的方法限制(只读、未运行代码)；5) 审查统计。要求：只使用已确认的发现，禁止新增；多个位置同类问题只写一次并指出其余位置；若没有任何确认发现，必须写明是未发现问题的审查，不得暗示已覆盖全部范围。输入：意图(JSON)" + JSON.stringify(map.intentSummary) + "；裁决结果(JSON)" + JSON.stringify(judgeValue) + "；盲区(JSON)" + JSON.stringify(blindValue) + "；测试情况(JSON)" + JSON.stringify(map.testNotes) + "；复核统计：确认 " + confirmed.length + " 条，剔除 " + rejectedCount + " 条，未完成复核 " + verificationFailures + " 个维度；完成审查的维度总数：" + batches.length + "。stats.dimensions 必须填写这个「完成审查的维度总数」，不得填成未完成复核的维度数。最终以 JSON 返回 report、stats。", { id: "report-writer", cli: "codex", label: "撰写报告", schema: finalSchema });
  if (!final) throw new Error("审查报告未能交付。");
  const recommendation = (judgeValue as { mergeRecommendation?: string }).mergeRecommendation ? (judgeValue as { mergeRecommendation: string }).mergeRecommendation : fallbackRecommendation;
  log("审查完成：确认 " + confirmed.length + " 条发现，合并建议 " + recommendation + "。");
  return { target: target, base: base, mergeRecommendation: recommendation, report: (final as { report: string }).report, blindSpots: (blindValue as { blindSpots?: unknown[] }).blindSpots ? (blindValue as { blindSpots: unknown[] }).blindSpots : [], stats: { confirmedFindings: confirmed.length, rejectedFindings: rejectedCount, dimensionsReviewed: batches.length, verificationFailures: verificationFailures } };
}