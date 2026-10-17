import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HarnessService } from "../../src/harness/service";
import { HarnessJournal, type HarnessEvent } from "../../src/harness/journal";
import { impactSummaryKey } from "../../src/harness/impact-summary";
import type { HarnessSession } from "../../src/harness/session";

const roots: string[] = [];
const services: HarnessService[] = [];
afterEach(async () => { for (const service of services.splice(0)) service.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const source = (name: string) => `const meta={name:"${name}",description:"归档",phases:[{title:"检查"}]};async function run(args:unknown){return {};}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const idleSession = async (): Promise<HarnessSession> => ({ isRunning: false, subscribe: () => () => {}, abort: () => {}, close: () => {}, prompt: async () => "不应调用模型" });
function service(state: string, factory?: () => Promise<HarnessSession>): HarnessService { const instance = new HarnessService(state, factory ?? idleSession, undefined, async () => ({ fingerprint: "injected-harness-session" })); services.push(instance); return instance; }
async function eventsOf(state: string, id: string): Promise<readonly HarnessEvent[]> { return (await HarnessJournal.open(id, state)).events; }

type Fixture = { readonly root: string; readonly state: string; readonly id: string; readonly executionId: string; readonly candidateCard: string; readonly decisionId: string; readonly summaryKey: string };

/**
 * 只经 Journal 预写事实构造归档现场：一条已终结执行带一条未完成总结义务、
 * 一份未处理候选草案和一个未回答决策；不启动任何主控回合或 Worker。
 * interruptSummary=true 时义务为 interrupted（失败重试前），否则保持 pending。
 */
async function fixture(options: { readonly interruptSummary?: boolean; readonly withCandidate?: boolean; readonly withDecision?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-")); roots.push(root);
  const state = join(root, "state");
  const creator = service(state);
  const task = await creator.create(root, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "a".repeat(64), title: "归档", initialGoal: "目标" });
  const id = task.harnessRunId;
  creator.close();
  const journal = (await HarnessJournal.open(id, state)).journal;
  const at = () => new Date().toISOString();
  const revision = (revisionNumber: number, cardId: string) => ({ revision: revisionNumber, cardId, parentRevision: null, goal: `目标${revisionNumber}`, scope: "只读", abandonedAt: null, turnId: task.messages[0].id, source: source(`archive-${revisionNumber}`), sourceHash: hash(source(`archive-${revisionNumber}`)), createdAt: at(), acceptedAt: null, rejectedAt: null });
  const executionId = crypto.randomUUID(), candidateCard = crypto.randomUUID(), decisionId = crypto.randomUUID();
  await journal.append({ type: "workflow.revision_proposed", at: at(), harnessRunId: id, revision: revision(1, crypto.randomUUID()) });
  await journal.append({ type: "workflow.revision_accepted", at: at(), harnessRunId: id, revision: 1 });
  await journal.append({ type: "workflow.execution_created", at: at(), harnessRunId: id, execution: { executionId, revision: 1, sourceHash: hash(source("archive-1")), runtimeVersion: 9, policy: { maxNodes: 20, maxGates: 10, maxPhaseVisits: 50 }, createdAt: at(), status: "running", finishedAt: null, diagnostic: null, summary: null } });
  const finished = at();
  await journal.append({ type: "workflow.execution_finished", at: finished, harnessRunId: id, executionId, status: "cancelled", diagnostic: "用户停止", summary: null, attempt: 1, impactSummaryRequired: true });
  const summaryKey = impactSummaryKey(id, executionId, 1, finished);
  if (options.interruptSummary) await journal.append({ type: "harness.summary_interrupted", at: at(), harnessRunId: id, key: summaryKey, diagnostic: "模型故障" });
  if (options.withCandidate !== false) await journal.append({ type: "workflow.revision_proposed", at: at(), harnessRunId: id, revision: revision(2, candidateCard) });
  if (options.withDecision !== false) await journal.append({ type: "harness.decision_requested", at: at(), harnessRunId: id, decision: { decisionId, question: "是否继续？", createdAt: at(), answer: null, answeredAt: null } });
  return { root, state, id, executionId, candidateCard, decisionId, summaryKey };
}

test("归档预览列出候选、各状态总结与未答决策；空任务可直接归档", async () => {
  const interrupted = await fixture({ interruptSummary: true });
  const preview = await service(interrupted.state).archivePreview(interrupted.id);
  expect(preview.harnessRunId).toBe(interrupted.id);
  expect(preview.requiresAbandon).toBe(true);
  expect(preview.candidate).toMatchObject({ revision: 2, cardId: interrupted.candidateCard, goal: "目标2", scope: "只读", origin: "generated", sourceHash: hash(source("archive-2")) });
  expect(preview.pendingSummaries).toEqual([{ key: interrupted.summaryKey, executionId: interrupted.executionId, attempt: 1, status: "interrupted" }]);
  expect(preview.pendingDecisions).toEqual([{ decisionId: interrupted.decisionId, question: "是否继续？", createdAt: expect.any(String) }]);

  // pending 义务如实列出；启动一次失败重试中的 running 义务也如实列出。
  const pending = await fixture({ interruptSummary: false });
  expect((await service(pending.state).archivePreview(pending.id)).pendingSummaries[0].status).toBe("pending");
  let release!: (text: string) => void;
  const hanging = service(pending.state, async (): Promise<HarnessSession> => ({ isRunning: true, subscribe: () => () => {}, abort: () => { release("已停止"); }, close: () => {}, prompt: () => new Promise((done) => { release = done; }) }));
  hanging.setExecutionCapsuleReader(async () => ({}));
  void hanging.retryImpactSummary(pending.id, pending.summaryKey).catch(() => {});
  for (let n = 0; n < 200; n++) { if ((await hanging.snapshot(pending.id)).impactSummaries![0].status === "running") break; await Bun.sleep(5); }
  expect((await hanging.archivePreview(pending.id)).pendingSummaries[0].status).toBe("running");
  await hanging.abort(pending.id);

  // 首次打开后再次预览是纯读：不产生任何新耐久事件。
  const before = (await eventsOf(interrupted.state, interrupted.id)).length;
  await service(interrupted.state).archivePreview(interrupted.id);
  expect((await eventsOf(interrupted.state, interrupted.id)).length).toBe(before);

  const clean = await service(interrupted.state).create(interrupted.root, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "b".repeat(64), title: "空", initialGoal: "空目标" });
  expect(await service(interrupted.state).archivePreview(clean.harnessRunId)).toMatchObject({ requiresAbandon: false, candidate: null, pendingSummaries: [], pendingDecisions: [] });
});

test("归档预览对已归档或不存在任务返回明确错误", async () => {
  const { state, id } = await fixture();
  const instance = service(state);
  await instance.complete(id, true);
  await expect(instance.archivePreview(id)).rejects.toThrow("已归档");
  await expect(instance.archivePreview(crypto.randomUUID())).rejects.toThrow();
});

test("已归档旧草案缺少或过期预览时，读取与幂等归档不补写封存后的事实", async () => {
  for (const oldPreview of [undefined, { previewVersion: 1, sourceHash: hash(source("archived-old")), phaseTitles: ["检查"], previewAgents: [] }]) {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-preview-")); roots.push(root);
    const state = join(root, "state"), creator = service(state);
    const task = await creator.create(root, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "a".repeat(64), title: "历史预览", initialGoal: "目标" });
    creator.close();
    const id = task.harnessRunId, cardId = crypto.randomUUID(), at = new Date().toISOString();
    const journal = (await HarnessJournal.open(id, state)).journal;
    await journal.append({ type: "workflow.revision_proposed", at, harnessRunId: id, revision: { revision: 1, cardId, parentRevision: null, goal: "目标", scope: "只读", abandonedAt: null, turnId: task.messages[0].id, source: source("archived-old"), sourceHash: hash(source("archived-old")), createdAt: at, acceptedAt: null, rejectedAt: null, ...(oldPreview ? { preview: oldPreview } : {}) } });
    await journal.append({ type: "workflow.card_abandoned", at, harnessRunId: id, cardId });
    await journal.append({ type: "harness.completed", at, harnessRunId: id });
    const path = join(state, id, "journal.jsonl"), before = await Bun.file(path).text();
    for (let attempt = 0; attempt < 2; attempt++) {
      const reader = service(state);
      expect((await reader.snapshot(id)).status).toBe("completed");
      expect((await reader.snapshot(id)).workflowRevisions[0].preview).toEqual(oldPreview);
      await expect(reader.archivePreview(id)).rejects.toThrow("已归档");
      expect((await reader.complete(id, true)).status).toBe("completed");
      reader.close();
      expect(await Bun.file(path).text()).toBe(before);
      expect((await HarnessJournal.open(id, state)).snapshot.status).toBe("completed");
    }
  }
});

test("协调归档一次确认：决策失效、候选放弃、总结取消并封存，重开一致", async () => {
  const { state, id, candidateCard, decisionId } = await fixture();
  const instance = service(state);
  const archived = await instance.complete(id, true);
  expect(archived.status).toBe("completed");
  expect(archived.completedAt).toBeString();
  expect(archived.workflowRevisions.at(-1)).toMatchObject({ revision: 2, cardId: candidateCard, abandonedAt: expect.any(String) });
  expect(archived.impactSummaries!.map((item) => item.status)).toEqual(["cancelled"]);
  expect(archived.decisions[0]).toMatchObject({ decisionId, answer: null, invalidatedAt: expect.any(String) });
  const events = await eventsOf(state, id);
  const order = events.map((event) => event.type);
  expect(order.indexOf("harness.decision_invalidated")).toBeLessThan(order.indexOf("workflow.card_abandoned"));
  expect(order.indexOf("workflow.card_abandoned")).toBeLessThan(order.lastIndexOf("harness.completed"));
  expect(events.filter((event) => event.type === "harness.completed").at(-1)).toMatchObject({ abandonImpactSummaries: true });
  // 耐久重开投影一致；封存后不能追加任何其他事实。
  const reopened = await HarnessJournal.open(id, state);
  expect(reopened.snapshot.status).toBe("completed");
  expect(reopened.snapshot.decisions[0].invalidatedAt).toBeString();
  // 封存事实之后追加的任何事件都让档案重放 fail closed。
  const corrupted = (await HarnessJournal.open(id, state)).journal;
  await corrupted.append({ type: "harness.decision_invalidated", at: new Date().toISOString(), harnessRunId: id, decisionId });
  await expect(HarnessJournal.open(id, state)).rejects.toThrow("已完成");
});

test("部分项已耐久后崩溃：重试只补剩余项，不重复写事实", async () => {
  const { state, id, candidateCard, decisionId } = await fixture();
  // 模拟上一轮协调归档在失效决策与放弃候选后、封存前崩溃。
  const journal = (await HarnessJournal.open(id, state)).journal;
  await journal.append({ type: "harness.decision_invalidated", at: new Date().toISOString(), harnessRunId: id, decisionId });
  await journal.append({ type: "workflow.card_abandoned", at: new Date().toISOString(), harnessRunId: id, cardId: candidateCard });
  const instance = service(state);
  const archived = await instance.complete(id, true);
  expect(archived.status).toBe("completed");
  expect(archived.impactSummaries!.every((item) => item.status === "cancelled")).toBe(true);
  const events = await eventsOf(state, id);
  expect(events.filter((event) => event.type === "harness.decision_invalidated")).toHaveLength(1);
  expect(events.filter((event) => event.type === "workflow.card_abandoned")).toHaveLength(1);
  expect(events.filter((event) => event.type === "harness.completed")).toHaveLength(1);
  // 封存事实已落盘后崩溃的同一请求重试：幂等返回，不再追加任何事件。
  const count = events.length;
  const retry = await instance.complete(id, true);
  expect(retry.status).toBe("completed");
  expect((await eventsOf(state, id)).length).toBe(count);
  // 并发重复归档只生效一次。
  const second = await fixture();
  const twin = service(second.state);
  const results = await Promise.all([twin.complete(second.id, true), twin.complete(second.id, true)]);
  expect(results.every((snapshot) => snapshot.status === "completed")).toBe(true);
  const twinEvents = await eventsOf(second.state, second.id);
  expect(twinEvents.filter((event) => event.type === "harness.completed")).toHaveLength(1);
  expect(twinEvents.filter((event) => event.type === "workflow.card_abandoned")).toHaveLength(1);
  expect(twinEvents.filter((event) => event.type === "harness.decision_invalidated")).toHaveLength(1);
});

test("落盘失败不报告已归档，修复后重试补齐且不重写事实", async () => {
  const { state, id } = await fixture();
  const instance = service(state);
  await instance.snapshot(id);
  const journalPath = join(state, id, "journal.jsonl");
  const before = (await eventsOf(state, id)).length;
  await chmod(journalPath, 0o400);
  await expect(instance.complete(id, true)).rejects.toThrow();
  expect((await instance.snapshot(id)).status).not.toBe("completed");
  expect((await eventsOf(state, id)).length).toBe(before);
  await chmod(journalPath, 0o600);
  const archived = await instance.complete(id, true);
  expect(archived.status).toBe("completed");
  const events = await eventsOf(state, id);
  expect(events.filter((event) => event.type === "harness.decision_invalidated")).toHaveLength(1);
  expect(events.filter((event) => event.type === "workflow.card_abandoned")).toHaveLength(1);
  expect(events.filter((event) => event.type === "harness.completed")).toHaveLength(1);
});

test("归档条件不满足拒绝且零写入：主控忙、执行未终态、待定项缺放弃确认", async () => {
  // 待定项未确认放弃：拒绝且 Journal 不增加任何事件。首次打开档案会补齐展示预览，
  // 因此先读一次快照再统计事件数。
  const { state, id } = await fixture();
  const instance = service(state);
  await instance.snapshot(id);
  const before = (await eventsOf(state, id)).length;
  await expect(instance.complete(id)).rejects.toThrow("影响面");
  await expect(instance.complete(id, false)).rejects.toThrow("影响面");
  expect((await eventsOf(state, id)).length).toBe(before);

  // 仅有候选草案且总结已完成的场景：严格归档提示先放弃候选。
  const cardRoot = await mkdtemp(join(tmpdir(), "wave-flow-archive-card-")); roots.push(cardRoot);
  const cardState = join(cardRoot, "state");
  const cardCreator = service(cardState);
  const cardTask = await cardCreator.create(cardRoot, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "f".repeat(64), title: "候选", initialGoal: "目标" });
  cardCreator.close();
  const cardAt = new Date().toISOString();
  await (await HarnessJournal.open(cardTask.harnessRunId, cardState)).journal.append({ type: "workflow.revision_proposed", at: cardAt, harnessRunId: cardTask.harnessRunId, revision: { revision: 1, cardId: crypto.randomUUID(), parentRevision: null, goal: "目标", scope: "只读", abandonedAt: null, turnId: cardTask.messages[0].id, source: source("card-1"), sourceHash: hash(source("card-1")), createdAt: cardAt, acceptedAt: null, rejectedAt: null } });
  await expect(service(cardState).complete(cardTask.harnessRunId)).rejects.toThrow("放弃尚未执行的候选");

  // 仅有未答决策：严格归档拒绝，协调归档只失效决策，completed 不带总结放弃标记。
  const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-decision-")); roots.push(root);
  const decisionState = join(root, "state");
  const creator = service(decisionState);
  const task = await creator.create(root, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "c".repeat(64), title: "决策", initialGoal: "目标" });
  creator.close();
  const decisionId = crypto.randomUUID();
  await (await HarnessJournal.open(task.harnessRunId, decisionState)).journal.append({ type: "harness.decision_requested", at: new Date().toISOString(), harnessRunId: task.harnessRunId, decision: { decisionId, question: "确认？", createdAt: new Date().toISOString(), answer: null, answeredAt: null } });
  const decider = service(decisionState);
  await expect(decider.complete(task.harnessRunId)).rejects.toThrow("未回答的主控决策");
  const archived = await decider.complete(task.harnessRunId, true);
  expect(archived.decisions[0].invalidatedAt).toBeString();
  const events = await eventsOf(decisionState, task.harnessRunId);
  expect(events.at(-1)).toMatchObject({ type: "harness.completed" });
  expect((events.at(-1) as { abandonImpactSummaries?: boolean }).abandonImpactSummaries).toBeUndefined();

  // 主控回合运行中不能归档。
  const busyRoot = await mkdtemp(join(tmpdir(), "wave-flow-archive-busy-")); roots.push(busyRoot);
  const busyState = join(busyRoot, "state");
  let release!: (text: string) => void;
  const busy = new HarnessService(busyState, async (): Promise<HarnessSession> => ({ isRunning: true, subscribe: () => () => {}, abort: () => {}, close: () => {}, prompt: () => new Promise((done) => { release = done; }) }), undefined, async () => ({ fingerprint: "injected-harness-session" }));
  services.push(busy);
  const conversation = await busy.create(busyRoot, "p");
  await busy.send(conversation.harnessRunId, "进行中");
  const busyBefore = (await eventsOf(busyState, conversation.harnessRunId)).length;
  await expect(busy.complete(conversation.harnessRunId, true)).rejects.toThrow("运行中");
  expect((await eventsOf(busyState, conversation.harnessRunId)).length).toBe(busyBefore);
  release("完成");

  // 存在未终结执行不能归档。
  const openRoot = await mkdtemp(join(tmpdir(), "wave-flow-archive-open-")); roots.push(openRoot);
  const openState = join(openRoot, "state");
  const openCreator = service(openState);
  const openTask = await openCreator.create(openRoot, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "e".repeat(64), title: "未终态", initialGoal: "目标" });
  openCreator.close();
  const openJournal = (await HarnessJournal.open(openTask.harnessRunId, openState)).journal;
  const at = new Date().toISOString();
  await openJournal.append({ type: "workflow.revision_proposed", at, harnessRunId: openTask.harnessRunId, revision: { revision: 1, cardId: crypto.randomUUID(), parentRevision: null, goal: "目标", scope: "只读", abandonedAt: null, turnId: openTask.messages[0].id, source: source("open-1"), sourceHash: hash(source("open-1")), createdAt: at, acceptedAt: null, rejectedAt: null } });
  await openJournal.append({ type: "workflow.revision_accepted", at, harnessRunId: openTask.harnessRunId, revision: 1 });
  await openJournal.append({ type: "workflow.execution_created", at, harnessRunId: openTask.harnessRunId, execution: { executionId: crypto.randomUUID(), revision: 1, sourceHash: hash(source("open-1")), runtimeVersion: 9, policy: { maxNodes: 20, maxGates: 10, maxPhaseVisits: 50 }, createdAt: at, status: "running", finishedAt: null, diagnostic: null, summary: null } });
  await expect(service(openState).complete(openTask.harnessRunId, true)).rejects.toThrow("未结束");
});

test("归档后所有写入口拒绝：消息/草案/卡操作/总结/决策/执行", async () => {
  const { state, id, executionId, candidateCard, decisionId, summaryKey } = await fixture();
  const instance = service(state);
  await instance.complete(id, true);
  await expect(instance.send(id, "继续")).rejects.toThrow("归档");
  await expect(instance.proposeWorkflowRevision(id, source("late"))).rejects.toThrow("归档");
  await expect(instance.acceptWorkflowRevision(id, 2)).rejects.toThrow("归档");
  await expect(instance.rejectWorkflowRevision(id, 2)).rejects.toThrow("归档");
  await expect(instance.abandonWorkflowCard(id, candidateCard)).rejects.toThrow();
  await expect(instance.retryImpactSummary(id, summaryKey)).rejects.toThrow("归档");
  await expect(instance.answerUserDecision(id, decisionId, {})).rejects.toThrow("归档");
  await expect(instance.recordExecutionResumed(id, executionId)).rejects.toThrow("归档");
  await expect(instance.recordExecutionFinished(id, executionId, "cancelled", null, null, 1)).rejects.toThrow("归档");
  // 迟到答案写入已失效决策会让档案重放 fail closed。
  const journal = (await HarnessJournal.open(id, state)).journal;
  await journal.append({ type: "harness.decision_answered", at: new Date().toISOString(), harnessRunId: id, decisionId, answer: {} });
  await expect(HarnessJournal.open(id, state)).rejects.toThrow();
});

test("候选缺少修订卡身份视为档案损坏：任何 append 之前拒绝且零写入", async () => {
  // 合法重放的单链档案候选必然携带 cardId（投影在 revision_proposed 时强制）；
  // 这里在内存投影层注入缺失，验证服务门禁与投影判定一致，不写入不可重放事件。
  const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-cardless-")); roots.push(root);
  const state = join(root, "state");
  const creator = service(state);
  const task = await creator.create(root, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "0".repeat(64), title: "损坏", initialGoal: "目标", workflowContract: "single-workflow-v1" });
  creator.close();
  const id = task.harnessRunId, at = new Date().toISOString();
  await (await HarnessJournal.open(id, state)).journal.append({ type: "workflow.revision_proposed", at, harnessRunId: id, revision: { revision: 1, cardId: crypto.randomUUID(), parentRevision: null, goal: "目标", scope: "只读", abandonedAt: null, turnId: task.messages[0].id, source: source("cardless-1"), sourceHash: hash(source("cardless-1")), createdAt: at, acceptedAt: null, rejectedAt: null } });
  const instance = service(state);
  const entry = await (instance as unknown as { entry(harnessRunId: string): Promise<{ projection: { snapshot(): import("../../src/harness/types").HarnessSnapshot } }> }).entry(id);
  const realSnapshot = entry.projection.snapshot.bind(entry.projection);
  entry.projection.snapshot = () => { const snapshot = realSnapshot(); return { ...snapshot, workflowRevisions: snapshot.workflowRevisions.map((revision, index, all) => index === all.length - 1 ? { ...revision, cardId: undefined } : revision) }; };
  const before = (await eventsOf(state, id)).length;
  await expect(instance.complete(id, true)).rejects.toThrow("修订卡身份");
  await expect(instance.complete(id)).rejects.toThrow("修订卡身份");
  expect((await instance.snapshot(id)).status).not.toBe("completed");
  expect((await eventsOf(state, id)).length).toBe(before);
  // 档案本身完好可重开，没有写入任何不可重放事件。
  expect((await HarnessJournal.open(id, state)).snapshot.status).toBe("idle");
});

test("批量落盘中途失败：同进程重试只补剩余项，不重复写事实", async () => {
  const { state, id, candidateCard, decisionId } = await fixture();
  // 第二个未答决策，使协调归档需要批量写入两条失效事实。
  const decision2 = crypto.randomUUID();
  await (await HarnessJournal.open(id, state)).journal.append({ type: "harness.decision_requested", at: new Date().toISOString(), harnessRunId: id, decision: { decisionId: decision2, question: "第二个问题", createdAt: new Date().toISOString(), answer: null, answeredAt: null } });
  const instance = service(state);
  const entry = await (instance as unknown as { entry(harnessRunId: string): Promise<{ journal: { append(event: HarnessEvent): Promise<void> } }> }).entry(id);
  const realAppend = entry.journal.append.bind(entry.journal);
  let invalidated = 0;
  entry.journal.append = async (event: HarnessEvent) => {
    if (event.type === "harness.decision_invalidated") { invalidated += 1; if (invalidated === 2) throw new Error("注入落盘失败"); }
    return realAppend(event);
  };
  // 第一条 decision_invalidated 成功、第二条失败：整体拒绝，不报已归档。
  await expect(instance.complete(id, true)).rejects.toThrow("注入落盘失败");
  expect((await instance.snapshot(id)).status).not.toBe("completed");
  let events = await eventsOf(state, id);
  expect(events.filter((event) => event.type === "harness.decision_invalidated")).toHaveLength(1);
  expect(events.filter((event) => event.type === "harness.completed")).toHaveLength(0);
  // 恢复后同一请求只补剩余项：已耐久的失效事实不重复写入。
  entry.journal.append = realAppend;
  const archived = await instance.complete(id, true);
  expect(archived.status).toBe("completed");
  expect(archived.decisions.map((item) => item.invalidatedAt)).toEqual([expect.any(String), expect.any(String)]);
  events = await eventsOf(state, id);
  expect(events.filter((event) => event.type === "harness.decision_invalidated")).toHaveLength(2);
  expect(events.filter((event) => event.type === "workflow.card_abandoned" && event.cardId === candidateCard)).toHaveLength(1);
  expect(events.filter((event) => event.type === "harness.completed")).toHaveLength(1);
  expect(events.filter((event) => event.type === "harness.decision_invalidated" && event.decisionId === decisionId)).toHaveLength(1);
});

test("未失效决策拒绝迟到答案，失效后不能再回答", async () => {
  const { state, id, decisionId } = await fixture({ withCandidate: false });
  const instance = service(state);
  // 回合外无等待者：未失效决策同样拒绝迟到答案，且不落盘。
  await expect(instance.answerUserDecision(id, decisionId, {})).rejects.toThrow("失效");
  const before = (await eventsOf(state, id)).length;
  await instance.complete(id, true);
  expect((await eventsOf(state, id)).length).toBe(before + 2);
  await expect(instance.answerUserDecision(id, decisionId, {})).rejects.toThrow("归档");
});

test("旧档案无决策失效事件仍可读：未答决策保持原状，恢复边界不变", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-legacy-")); roots.push(root);
  const state = join(root, "state");
  const creator = service(state);
  const task = await creator.create(root, "p", { clientRequestId: crypto.randomUUID(), payloadHash: "d".repeat(64), title: "旧档", initialGoal: "目标" });
  creator.close();
  const id = task.harnessRunId, decisionId = crypto.randomUUID();
  const journal = (await HarnessJournal.open(id, state)).journal;
  // 旧格式归档：存在从未失效的未答决策，封存事件不带任何新字段。
  await journal.append({ type: "harness.decision_requested", at: new Date().toISOString(), harnessRunId: id, decision: { decisionId, question: "旧问题", createdAt: new Date().toISOString(), answer: null, answeredAt: null } });
  await journal.append({ type: "harness.completed", at: new Date().toISOString(), harnessRunId: id });
  const reopened = service(state);
  const snapshot = await reopened.snapshot(id);
  expect(snapshot.status).toBe("completed");
  expect(snapshot.decisions[0]).toMatchObject({ decisionId, answer: null, answeredAt: null });
  expect(snapshot.decisions[0].invalidatedAt ?? null).toBeNull();
  await expect(reopened.answerUserDecision(id, decisionId, {})).rejects.toThrow("归档");
  await expect(reopened.complete(id)).rejects.toThrow("已完成");
});
