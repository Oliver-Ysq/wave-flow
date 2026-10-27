const meta = {
  name: "deep-research",
  description: "多源深度调研、逐条核验并批判修订",
  phases: [{ title: "计划" }, { title: "调研" }, { title: "核验" }, { title: "交叉检查与补证" }, { title: "综评" }, { title: "批判" }, { title: "定稿" }],
  exampleArgs: { topic: "端侧大模型推理框架的现状与选型", depth: "deep" }
};
type Args = { topic: string; questions?: string[]; context?: string; depth?: string; language?: string };
type Question = { title: string; keyPoints: string[]; searchHints: string[] };
type Plan = { brief: string; questions: Question[]; controversies: string[] };
type FindingEvidence = { title: string; url: string; excerpt: string; publishedAt?: string };
type Finding = { claim: string; evidence: FindingEvidence[]; confidence: string; asOf?: string };
type ResearchBatch = { findings: Finding[]; gaps: string[]; failedSources: string[] };
type VerifyBatch = { verified: Finding[]; rejected: { claim: string; reason: string }[]; corrections: string[] };

async function run(args: Args) {
  const topic = args.topic;
  const language = typeof args.language === "string" && args.language.trim() !== "" ? args.language : "中文";
  const deep = args.depth === "deep";
  const extraQuestions = args.questions ? args.questions : [];
  const context = typeof args.context === "string" ? args.context : "";
  phase("计划");
  log("正在把调研主题拆解为可独立并行、可逐条核验的研究问题清单。");
  const planSchema = { type: "object", properties: { brief: { type: "string" }, questions: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: { title: { type: "string" }, keyPoints: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } }, searchHints: { type: "array", maxItems: 6, items: { type: "string" } } }, required: ["title", "keyPoints", "searchHints"], additionalProperties: false } }, controversies: { type: "array", maxItems: 5, items: { type: "string" } } }, required: ["brief", "questions", "controversies"], additionalProperties: false };
  const planPrompt = "你是一名调研主编。请把下面的调研主题拆解为 3 到 5 个互相独立、可以并行交给不同调研员的研究问题，并给出研究简报。要求：1) 每个研究问题必须具体、可回答、可核验，给出 title、keyPoints(该问题必须回答的 2 到 5 个要点)和 searchHints(4 到 6 个建议检索词)；2) 给出 brief(研究简报：目标、范围、验收标准、读者)，brief 是后续所有调研和验收的基准；3) 列出 controversies(该主题公开讨论中已知的争议点或容易失真的说法，没有就为空数组)；4) 不要编造用户没有说过的约束或意图，不确定的范围写进 controversies 并在 brief 中标注 open；5) 全部用 " + language + " 输出。用户输入：" + JSON.stringify({ topic: topic, questions: extraQuestions, context: context });
  const first = await agent(planPrompt, { id: "planner", cli: "codex", label: "调研计划", schema: planSchema });
  if (!first) throw new Error("调研计划未能交付。");
  let plan = first as Plan;
  log("调研简报：" + plan.brief);
  const titles = plan.questions.map((item) => item.title);
  const decision = await decisionGate("approve-research-plan", "请确认调研计划。简报：" + plan.brief + "；研究问题：" + titles.join(" / ") + "。如不同意，请在 adjustments 中说明要调整的方向。", { type: "object", properties: { approved: { type: "boolean", description: "是否同意按该计划继续调研" }, adjustments: { type: "string", description: "不同意时请写明要调整的方向；同意可留空" } }, required: ["approved", "adjustments"], additionalProperties: false });
  if (decision.approved !== true) {
    const adjustments = typeof decision.adjustments === "string" ? decision.adjustments : "";
    if (adjustments.trim() === "") throw new Error("调研计划未获批准，且没有提供调整说明。");
    log("根据用户意见调整调研计划。");
    const revised = await agent(planPrompt + "。这是对上一版计划的调整要求，请重新输出完整计划：" + adjustments, { id: "planner-revised", cli: "codex", label: "调整调研计划", schema: planSchema });
    if (!revised) throw new Error("调整后的调研计划未能交付。");
    plan = revised as Plan;
  }
  const researchSchema = { type: "object", properties: { findings: { type: "array", maxItems: 6, items: { type: "object", properties: { claim: { type: "string" }, evidence: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, excerpt: { type: "string" }, publishedAt: { type: "string" } }, required: ["title", "url", "excerpt"], additionalProperties: false } }, confidence: { type: "string", enum: ["high", "medium", "low"] }, asOf: { type: "string" } }, required: ["claim", "evidence", "confidence"], additionalProperties: false } }, gaps: { type: "array", maxItems: 5, items: { type: "string" } }, failedSources: { type: "array", maxItems: 5, items: { type: "string" } } }, required: ["findings", "gaps", "failedSources"], additionalProperties: false };
  const researchPrompt = (question: Question) => "你是一名调研员，只负责下面这一个独立研究问题，不要越界研究其他问题。调研主题：" + topic + "；研究简报：" + plan.brief + "。研究问题：" + question.title + "；必须回答的要点：" + JSON.stringify(question.keyPoints) + "；建议检索词：" + JSON.stringify(question.searchHints) + "。要求：1) 使用你会话中可用的检索和浏览工具收集证据，每条 URL 必须来自一次真实检索，禁止凭记忆编造 URL；2) 每条结论 claim 用 " + language + " 书写，必须附 1 到 5 条证据，每条证据含 title、url、excerpt(原文摘录，不超过 300 字)、publishedAt(来源发布日期，没有就省略)；3) 给每条结论标 confidence(high/medium/low)，时效敏感的结论在 asOf 说明时效窗口；4) 检索不到或无法证实的要点写进 gaps，尝试过但失败的来源写进 failedSources，禁止用推测补空；5) 优先官方或一手来源，同一研究的多个转载只算一个来源。最终以 JSON 返回。";
  const runResearch = (question: Question, round: number, index: number) => async () => {
    const prefix = round === 2 ? "research-r2-" : "research-r1-";
    log("- 开始调研：" + question.title);
    const result = await agent(researchPrompt(question), { id: prefix + (index + 1), cli: "codex", label: "调研 " + question.title, schema: researchSchema });
    if (result) {
      const batch = result as ResearchBatch;
      log("- 完成调研：" + question.title + "，提交 " + batch.findings.length + " 条结论，缺口 " + batch.gaps.length + " 个");
    } else {
      log("- 调研失败：" + question.title);
    }
    return result as ResearchBatch | null;
  };
  phase("调研");
  log("第一轮：并行调研 " + plan.questions.length + " 个研究问题。");
  const round1 = await parallel(plan.questions.map((question, index) => runResearch(question, 1, index)));
  const pairs: { title: string; batch: ResearchBatch }[] = [];
  /** 调研直接失败、因此完全没有对应结论的问题；必须显式写进报告的未解决问题。 */
  const unresearched: string[] = [];
  /** 结论撞上核验节点失败、未能进入报告的问题；同样要显式列出。 */
  const unverified: string[] = [];
  let round1Succeeded = 0;
  plan.questions.forEach((question, index) => {
    const batch = round1[index];
    if (batch !== null) {
      pairs.push({ title: question.title, batch: batch });
      round1Succeeded = round1Succeeded + 1;
    } else {
      unresearched.push(question.title);
    }
  });
  if (pairs.length === 0) throw new Error("第一轮调研没有任何可用结果。");
  const verifySchema = { type: "object", properties: { verified: { type: "array", maxItems: 6, items: { type: "object", properties: { claim: { type: "string" }, evidence: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, excerpt: { type: "string" }, publishedAt: { type: "string" } }, required: ["title", "url", "excerpt"], additionalProperties: false } }, confidence: { type: "string", enum: ["high", "medium", "low"] }, asOf: { type: "string" } }, required: ["claim", "evidence", "confidence"], additionalProperties: false } }, rejected: { type: "array", maxItems: 6, items: { type: "object", properties: { claim: { type: "string" }, reason: { type: "string" } }, required: ["claim", "reason"], additionalProperties: false } }, corrections: { type: "array", maxItems: 5, items: { type: "string" } } }, required: ["verified", "rejected", "corrections"], additionalProperties: false };
  const runVerify = (pair: { title: string; batch: ResearchBatch }, round: number, index: number) => async () => {
    const prefix = round === 2 ? "verify-r2-" : "verify-r1-";
    log("- 开始核验：" + pair.title);
    const prompt = "你是一名核验员，独立复核一名调研员提交的结论批次，只剔除有依据的误报，不新增结论。调研主题：" + topic + "；被复核批次(JSON)：" + JSON.stringify(pair.batch) + "。逐条检查：1) 使用你的浏览工具重新打开关键 URL，核对 excerpt 是否真实存在且支持 claim；浏览工具不可用时依据内部一致性与常识判断，并在 corrections 中明确注明未能打开的来源；2) claim 是否超出证据支持范围，超出就降低 confidence 或剔除；3) 同一证据被多条结论重复引用时合并；4) 无原文依据、来源无法确认、或与公开事实明显矛盾的结论放进 rejected 并给 reason；5) verified 保持原结构，confidence 可重新校准。最终以 JSON 返回。";
    const result = await agent(prompt, { id: prefix + (index + 1), cli: "codex", label: "核验 " + pair.title, schema: verifySchema });
    if (result) {
      const verdict = result as VerifyBatch;
      log("- 完成核验：" + pair.title + "，确认 " + verdict.verified.length + " 条，剔除 " + verdict.rejected.length + " 条");
    } else {
      log("- 核验失败：" + pair.title);
    }
    return result as VerifyBatch | null;
  };
  phase("核验");
  log("独立核验员逐条对照原始来源复核 " + pairs.length + " 个批次。");
  const verified1 = await parallel(pairs.map((pair, index) => runVerify(pair, 1, index)));
  const confirmed: { title: string; findings: Finding[] }[] = [];
  let rejectedCount = 0;
  let verificationFailures = 0;
  verified1.forEach((verdict, index) => {
    if (verdict === null) {
      verificationFailures = verificationFailures + 1;
      unverified.push(pairs[index]!.title);
      return;
    }
    confirmed.push({ title: pairs[index]!.title, findings: verdict.verified });
    rejectedCount = rejectedCount + verdict.rejected.length;
  });
  if (confirmed.length === 0) throw new Error("没有任何结论通过核验。");
  if (verificationFailures > 0) log("注意：" + verificationFailures + " 个批次的核验节点未交付，其结论未计入本报告。");
  const crossSchema = { type: "object", properties: { claims: { type: "array", maxItems: 12, items: { type: "object", properties: { claim: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, sourceFamilyCount: { type: "integer" }, contradictions: { type: "array", maxItems: 3, items: { type: "string" } } }, required: ["claim", "confidence", "sourceFamilyCount", "contradictions"], additionalProperties: false } }, gaps: { type: "array", maxItems: 3, items: { type: "string" } }, summary: { type: "string" } }, required: ["claims", "gaps", "summary"], additionalProperties: false };
  phase("交叉检查与补证");
  log("交叉检查已核验结论：矛盾检测、证据家族去重与缺口清单。");
  const cross = await agent("你是交叉检查员。基于以下已通过核验的结论(按研究问题分组)与已知争议点，做三件事：1) 矛盾检测：找出互相冲突的结论，在 contradictions 中说明冲突点；2) 证据家族去重：同一原始研究或同一通稿的多个转载算一个证据家族，给每条结论标 sourceFamilyCount；3) 缺口分析：哪些研究问题没有被回答、哪些承重结论只有单一证据家族，写入 gaps(最多 3 条，每条是一个可执行的定向补证问题；没有就空数组)。confidence 按证据强度重新校准。已核验结论(JSON)：" + JSON.stringify(confirmed) + "；已知争议点(JSON)：" + JSON.stringify(plan.controversies) + "。最终以 JSON 返回 claims、gaps、summary。", { id: "cross-check", cli: "codex", label: "交叉检查", schema: crossSchema });
  const round2Pairs: { title: string; batch: ResearchBatch }[] = [];
  let round2QuestionCount = 0;
  let round2Succeeded = 0;
  let crossGaps: string[] = [];
  // 缺口清单与深度无关：standard 模式不补证，但缺口仍要交给报告列入未解决问题。
  if (cross !== null) crossGaps = (cross as { gaps?: string[] }).gaps ? (cross as { gaps: string[] }).gaps : [];
  if (deep && cross !== null) {
    if (crossGaps.length > 0) {
      const picked = crossGaps.slice(0, 2).map((gap, index) => ({ title: "补证 " + (index + 1) + "：" + gap, keyPoints: [gap], searchHints: [gap] }));
      round2QuestionCount = picked.length;
      log("第二轮：针对 " + picked.length + " 个证据缺口做定向补证。");
      const round2 = await parallel(picked.map((question, index) => runResearch(question, 2, index)));
      picked.forEach((question, index) => {
        const batch = round2[index];
        if (batch !== null) {
          round2Pairs.push({ title: question.title, batch: batch });
          round2Succeeded = round2Succeeded + 1;
        } else {
          unresearched.push(question.title);
        }
      });
      const verified2 = await parallel(round2Pairs.map((pair, index) => runVerify(pair, 2, index)));
      verified2.forEach((verdict, index) => {
        if (verdict === null) {
          verificationFailures = verificationFailures + 1;
          unverified.push(round2Pairs[index]!.title);
          return;
        }
        confirmed.push({ title: round2Pairs[index]!.title, findings: verdict.verified });
        rejectedCount = rejectedCount + verdict.rejected.length;
      });
    } else {
      log("交叉检查没有发现需要补证的缺口，跳过第二轮。");
    }
  } else if (!deep) {
    log("standard 深度模式：跳过第二轮补证，交叉检查的缺口直接列入未解决问题。");
  } else {
    log("交叉检查节点未交付，跳过第二轮补证；本报告的覆盖范围因此更窄。");
  }
  const totalFindings = confirmed.reduce((sum, group) => sum + group.findings.length, 0);
  log("进入综评：共 " + totalFindings + " 条已核验结论，" + rejectedCount + " 条被剔除。");
  phase("综评");
  const synthSchema = { type: "object", properties: { report: { type: "string" }, citations: { type: "array", maxItems: 20, items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" } }, required: ["id", "title", "url"], additionalProperties: false } }, keyTakeaways: { type: "array", maxItems: 5, items: { type: "string" } } }, required: ["report", "citations", "keyTakeaways"], additionalProperties: false };
  const synthInput = { brief: plan.brief, controversies: plan.controversies, confirmed: confirmed, crossClaims: cross === null ? [] : (cross as { claims?: unknown }).claims, unresolvedGaps: crossGaps, failedVerifications: verificationFailures, unresearchedQuestions: unresearched, unverifiedQuestions: unverified };
  const draft = await agent("你是报告撰写人。基于以下已通过核验的结论，撰写一份 " + language + " 深度调研报告(markdown)。结构：1) 执行摘要；2) 按研究问题逐节回答，每节给出结论与引用编号 [n]；3) 共识与分歧(矛盾结论并列呈现，不得擅自调和)；4) 置信度说明与证据局限；5) 未解决问题与后续建议。要求：每个承重结论必须带 [n] 引用编号，编号对应 citations 数组；只使用输入中核验通过的结论，禁止新增未经核验的事实；unresolvedGaps 是尚未解决的证据缺口，必须在未解决问题一节如实列出；unresearchedQuestions 是调研直接失败、unverifiedQuestions 是核验失败而未能进入本报告的研究问题，两类都必须逐条写进未解决问题一节并说明原因，不得省略、不得用常识补写；failedVerifications 大于 0 时必须在证据局限一节说明有多少批次未完成核验；keyTakeaways 给 3 到 5 条最重要的可执行结论。输入(JSON)：" + JSON.stringify(synthInput) + "。最终以 JSON 返回 report、citations、keyTakeaways。", { id: "synthesizer", cli: "codex", label: "撰写报告", schema: synthSchema });
  if (!draft) throw new Error("报告撰写未能交付。");
  const criticSchema = { type: "object", properties: { issues: { type: "array", maxItems: 10, items: { type: "object", properties: { severity: { type: "string", enum: ["major", "minor"] }, target: { type: "string" }, problem: { type: "string" }, fix: { type: "string" } }, required: ["severity", "target", "problem", "fix"], additionalProperties: false } }, verdict: { type: "string", enum: ["pass", "revise"] }, assessment: { type: "string" } }, required: ["issues", "verdict", "assessment"], additionalProperties: false };
  phase("批判");
  log("红队反向审查报告初稿：单一来源、时效、引用对应与逻辑跳跃。");
  const criticism = await agent("你是红队评审，反向审查这份调研报告初稿。逐项检查：1) 哪些承重结论可能错误，为什么；2) 哪些结论只依赖单一证据家族或单一来源；3) 时间敏感结论是否与来源日期矛盾；4) 引用 [n] 与结论是否一一对应，有没有无引用的承重结论；5) 有没有逻辑跳跃或以偏概全；6) 研究简报承诺回答的问题中哪些没有被回答，特别是输入里 unresearchedQuestions 与 unverifiedQuestions 列出的问题是否在报告中显式说明。找不到问题就明确写没有，禁止为凑数编造问题。初稿(JSON)：" + JSON.stringify(draft) + "；已核验结论(JSON)：" + JSON.stringify(confirmed) + "；未调研成功的问题(JSON)：" + JSON.stringify(unresearched) + "；未通过核验的问题(JSON)：" + JSON.stringify(unverified) + "。最终以 JSON 返回 issues、verdict、assessment。", { id: "critic", cli: "codex", label: "红队审查", schema: criticSchema });
  phase("定稿");
  let finalReport = (draft as { report: string; citations: unknown[]; keyTakeaways: string[] }).report;
  let finalCitations = (draft as { citations: unknown[] }).citations;
  let finalKeyTakeaways = (draft as { keyTakeaways: string[] }).keyTakeaways;
  let changesMade: string[] = [];
  let remainingLimitations: string[] = [];
  let criticIssueCount = 0;
  const criticDelivered = criticism !== null;
  const criticHasIssues = criticDelivered && (criticism as { issues: unknown[] }).issues.length > 0;
  if (criticDelivered && ((criticism as { verdict: string }).verdict === "revise" || criticHasIssues)) {
    log("根据红队意见修订报告。");
    const revisionSchema = { type: "object", properties: { report: { type: "string" }, citations: { type: "array", maxItems: 20, items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" } }, required: ["id", "title", "url"], additionalProperties: false } }, keyTakeaways: { type: "array", maxItems: 5, items: { type: "string" } }, changesMade: { type: "array", maxItems: 10, items: { type: "string" } }, remainingLimitations: { type: "array", maxItems: 5, items: { type: "string" } } }, required: ["report", "citations", "keyTakeaways", "changesMade", "remainingLimitations"], additionalProperties: false };
    const revision = await agent("你是修订人。根据红队评审意见修订调研报告，输出最终版。要求：逐条处理 issues(确实成立才改，不成立的在 remainingLimitations 说明)；保持引用编号与 citations 一致；不引入任何未经核验的新事实；keyTakeaways 与修订后的正文保持一致。初稿(JSON)：" + JSON.stringify(draft) + "；红队意见(JSON)：" + JSON.stringify(criticism) + "。最终以 JSON 返回 report、citations、keyTakeaways、changesMade、remainingLimitations。", { id: "reviser", cli: "codex", label: "修订报告", schema: revisionSchema });
    if (revision) {
      const fixed = revision as { report: string; citations: unknown[]; keyTakeaways: string[]; changesMade: string[]; remainingLimitations: string[] };
      finalReport = fixed.report;
      finalCitations = fixed.citations;
      finalKeyTakeaways = fixed.keyTakeaways;
      changesMade = fixed.changesMade;
      remainingLimitations = fixed.remainingLimitations;
    }
    criticIssueCount = (criticism as { issues: unknown[] }).issues.length;
  } else if (criticDelivered) {
    log("红队审查通过，未提出需要修订的问题。");
  } else {
    log("红队审查节点未交付，报告按初稿定稿；本次缺少独立的反向审查。");
  }
  log("调研完成：最终报告已产出。");
  return { topic: topic, depth: deep ? "deep" : "standard", brief: plan.brief, report: finalReport, keyTakeaways: finalKeyTakeaways, citations: finalCitations, changesMade: changesMade, remainingLimitations: remainingLimitations, stats: { round1Attempted: round1.length, round1Succeeded: round1Succeeded, round2Questions: round2QuestionCount, round2Succeeded: round2Succeeded, verifiedGroups: confirmed.length, verifiedFindings: totalFindings, rejectedFindings: rejectedCount, verificationFailures: verificationFailures, criticDelivered: criticDelivered, criticIssues: criticIssueCount } };
}