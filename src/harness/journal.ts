import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Ajv from "ajv";
import { harnessRunDirectory, harnessRunsRoot, validateRunId, waveFlowHome } from "../journal/paths";
import { isJsonObject, type JsonObject } from "../shared/json";
import type { HarnessDecision, HarnessMessage, HarnessSnapshot, HarnessStatus, HarnessToolActivity, WorkflowExecutionRecord, WorkflowRevision } from "./types";
import type { RuntimeProvenance } from "../runtimes/types";

/** 独立 Harness 档案格式；v2 增加 WorkflowExecution 登记与主控决策事实，v1 只读兼容。 */
export const HARNESS_JOURNAL_VERSION = 4;
/** 可读取的历史 Harness 档案版本。 */
export const COMPATIBLE_HARNESS_JOURNAL_VERSIONS = [1, 2, 3, HARNESS_JOURNAL_VERSION] as const;

export type HarnessManifest = {
  readonly harnessRunId: string;
  /** 创建该 Harness 的耐久项目；历史档案缺失时按未归类处理。 */
  readonly projectId?: string;
  readonly version: number;
  readonly cwd: string;
  readonly modelFingerprint: string;
  /** 创建时冻结的安全 CLI runtime 来源；v1-v3 历史档案缺失时为未知。 */
  readonly runtime?: RuntimeProvenance;
  readonly createdAt: string;
};

type HarnessEvent =
  | { readonly type: "harness.created"; readonly at: string; readonly harnessRunId: string }
  | { readonly type: "harness.user_message"; readonly at: string; readonly harnessRunId: string; readonly message: HarnessMessage }
  | { readonly type: "harness.turn_started"; readonly at: string; readonly harnessRunId: string; readonly userMessageId: string }
  | { readonly type: "harness.assistant_message"; readonly at: string; readonly harnessRunId: string; readonly message: HarnessMessage }
  | { readonly type: "harness.tool_activity"; readonly at: string; readonly harnessRunId: string; readonly messageId: string; readonly activities: readonly HarnessToolActivity[] }
  | { readonly type: "harness.turn_finished"; readonly at: string; readonly harnessRunId: string; readonly messageId: string }
  | { readonly type: "harness.turn_interrupted"; readonly at: string; readonly harnessRunId: string; readonly diagnostic: string }
  | { readonly type: "harness.completed"; readonly at: string; readonly harnessRunId: string }
  | { readonly type: "workflow.revision_proposed"; readonly at: string; readonly harnessRunId: string; readonly revision: WorkflowRevision }
  | { readonly type: "workflow.revision_accepted"; readonly at: string; readonly harnessRunId: string; readonly revision: number }
  | { readonly type: "workflow.execution_created"; readonly at: string; readonly harnessRunId: string; readonly execution: WorkflowExecutionRecord }
  | { readonly type: "workflow.execution_finished"; readonly at: string; readonly harnessRunId: string; readonly executionId: string; readonly status: WorkflowExecutionRecord["status"]; readonly diagnostic: string | null; readonly summary: JsonObject | null }
  /** 用户显式恢复同一冻结 revision；新 attempt 的终态仍由 execution_finished 写入。 */
  | { readonly type: "workflow.execution_resumed"; readonly at: string; readonly harnessRunId: string; readonly executionId: string }
  | { readonly type: "harness.decision_requested"; readonly at: string; readonly harnessRunId: string; readonly decision: HarnessDecision }
  | { readonly type: "harness.decision_answered"; readonly at: string; readonly harnessRunId: string; readonly decisionId: string; readonly answer: JsonObject };

/** Harness 的 append-only 耐久档案。reasoning/delta 永远不属于 Journal 事件。 */
export class HarnessJournal {
  #appendQueue: Promise<void> = Promise.resolve();
  private constructor(readonly manifest: HarnessManifest, readonly directory: string) {}

  static async create(manifest: HarnessManifest, root = harnessRunsRoot()): Promise<HarnessJournal> {
    validateManifest(manifest);
    const directory = harnessRunDirectory(root, manifest.harnessRunId);
    await ensureHome(root);
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(directory);
    await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writePrivateFile(join(directory, "journal.jsonl"), "");
    const journal = new HarnessJournal(manifest, directory);
    await journal.append({ type: "harness.created", at: manifest.createdAt, harnessRunId: manifest.harnessRunId });
    return journal;
  }

  static async open(harnessRunId: string, root = harnessRunsRoot()): Promise<{ readonly journal: HarnessJournal; readonly snapshot: HarnessSnapshot; readonly events: readonly HarnessEvent[] }> {
    validateRunId(harnessRunId);
    await ensureHome(root, false);
    await assertPrivateDirectory(root);
    const directory = harnessRunDirectory(root, harnessRunId);
    const manifestPath = join(directory, "manifest.json");
    const journalPath = join(directory, "journal.jsonl");
    let manifestValue: unknown;
    try { await assertPrivateFile(manifestPath); manifestValue = JSON.parse(await readFile(manifestPath, "utf8")); } catch { throw new Error("指定 Harness Run 不存在或 manifest 不可读取。 "); }
    const manifest = validateManifest(manifestValue);
    if (manifest.harnessRunId !== harnessRunId) throw new Error("Harness manifest id 不一致。 ");
    let source: string;
    try { await assertPrivateFile(journalPath); source = await readFile(journalPath, "utf8"); } catch { throw new Error("指定 Harness Run 的 Journal 不可读取。 "); }
    const events: HarnessEvent[] = [];
    const state = new HarnessProjection(manifest);
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let value: unknown;
      try { value = JSON.parse(lines[index]); } catch {
        if (lines.slice(index + 1).some((line) => line.trim()) || !isTruncatedTail(lines[index])) throw new Error(`Harness Journal 第 ${index + 1} 行损坏。`);
        continue;
      }
      try { const event = validateEvent(value, harnessRunId); state.apply(event); events.push(event); } catch (error) { throw new Error(`Harness Journal 第 ${index + 1} 行损坏：${error instanceof Error ? error.message : String(error)}`); }
    }
    return { journal: new HarnessJournal(manifest, directory), snapshot: state.snapshot(), events };
  }

  async append(event: HarnessEvent): Promise<void> {
    validateEvent(event, this.manifest.harnessRunId);
    const task = this.#appendQueue.then(() => appendPrivateJournalLine(join(this.directory, "journal.jsonl"), `${JSON.stringify(event)}\n`));
    this.#appendQueue = task.catch(() => undefined);
    return task;
  }
}

/** 从独立 Harness Journal 还原只读 UI 快照。 */
export class HarnessProjection {
  #created = false;
  #status: HarnessStatus = "idle";
  #diagnostic: string | null = null;
  #completedAt: string | null = null;
  #messages: HarnessMessage[] = [];
  #turnUserMessageId: string | null = null;
  #assistantMessageId: string | null = null;
  #toolActivitiesByMessageId: Record<string, HarnessToolActivity[]> = {};
  #workflowRevisions: WorkflowRevision[] = [];
  #executions: WorkflowExecutionRecord[] = [];
  #decisions: HarnessDecision[] = [];
  constructor(private readonly manifest: HarnessManifest) {}
  apply(event: HarnessEvent): void {
    if (event.harnessRunId !== this.manifest.harnessRunId) throw new Error("Harness 事件不属于当前会话。 ");
    if (!this.#created && event.type !== "harness.created") throw new Error("Harness 首条事件必须是 created。 ");
    // “完成”是会话档案的终态，而非仅供 Web 隐藏的一枚标签。完成事实之后
    // 不得再写入消息、草案、执行登记或决策，重开 Journal 时同样 fail closed。
    if (this.#completedAt !== null && event.type !== "harness.completed") throw new Error("已完成的 Harness 不能追加新事实。 ");
    if (event.type === "harness.created") { if (this.#created) throw new Error("Harness created 重复。 "); this.#created = true; return; }
    if (event.type === "harness.user_message") { if (this.#status === "running" || this.#status === "completed") throw new Error("已完成或运行中的 Harness 不能追加用户消息。 "); this.#messages.push(event.message); this.#status = "idle"; this.#diagnostic = null; return; }
    if (event.type === "harness.turn_started") { if (this.#status === "running" || this.#messages.at(-1)?.id !== event.userMessageId) throw new Error("Harness turn_started 不匹配最新用户消息。 "); this.#status = "running"; this.#turnUserMessageId = event.userMessageId; return; }
    if (event.type === "harness.assistant_message") { if (this.#status !== "running" || event.message.role !== "assistant" || this.#assistantMessageId) throw new Error("Harness assistant_message 不合法。 "); this.#messages.push(event.message); this.#assistantMessageId = event.message.id; return; }
    if (event.type === "harness.tool_activity") { if (this.#status !== "running" || this.#assistantMessageId !== event.messageId) throw new Error("Harness tool_activity 必须绑定当前 assistant 消息。 "); this.#toolActivitiesByMessageId[event.messageId] = event.activities.map((item) => ({ ...item })); return; }
    if (event.type === "harness.turn_finished") { if (this.#status !== "running" || this.#assistantMessageId !== event.messageId) throw new Error("Harness turn_finished 缺少完整 assistant 消息。 "); this.#status = "idle"; this.#turnUserMessageId = null; this.#assistantMessageId = null; return; }
    if (event.type === "harness.turn_interrupted") { if (this.#status !== "running") throw new Error("Harness turn_interrupted 必须来自运行中回合。 "); this.#status = "interrupted"; this.#diagnostic = event.diagnostic; this.#turnUserMessageId = null; this.#assistantMessageId = null; return; }
    if (event.type === "harness.completed") { if (this.#status === "running" || this.#completedAt !== null) throw new Error("Harness 只能在空闲或中断后完成一次。 "); if (this.#executions.some((item) => item.finishedAt === null)) throw new Error("存在未结束 Execution 时不能完成 Harness。 "); this.#status = "completed"; this.#completedAt = event.at; this.#diagnostic = null; return; }
    if (event.type === "workflow.revision_proposed") { if (this.#workflowRevisions.length + 1 !== event.revision.revision || event.revision.acceptedAt !== null) throw new Error("Workflow revision 序号或状态无效。 "); this.#workflowRevisions.push(event.revision); return; }
    if (event.type === "workflow.revision_accepted") { const revision = this.#workflowRevisions.at(-1); if (!revision || revision.revision !== event.revision || revision.acceptedAt !== null) throw new Error("Workflow revision 只能按最新未接受草案冻结。 "); this.#workflowRevisions[this.#workflowRevisions.length - 1] = { ...revision, acceptedAt: event.at }; return; }
    if (event.type === "workflow.execution_created") {
      const revision = this.#workflowRevisions.find((item) => item.revision === event.execution.revision);
      // Execution 只能绑定已接受冻结的 revision；草稿或序号不存在的草案永远不能执行。
      if (!revision || revision.acceptedAt === null || revision.sourceHash !== event.execution.sourceHash) throw new Error("WorkflowExecution 必须绑定已接受冻结的 revision。 ");
      if (this.#executions.some((item) => item.executionId === event.execution.executionId)) throw new Error("WorkflowExecution id 重复。 ");
      // 一个 Harness 顺序拥有多个 Execution：前一个未到终态时不得创建新执行。
      if (this.#executions.some((item) => item.finishedAt === null)) throw new Error("存在未结束的 WorkflowExecution，不能创建新执行。 ");
      if (event.execution.finishedAt !== null || event.execution.status !== "running") throw new Error("新建 WorkflowExecution 必须是 running 且未结束。 ");
      this.#executions.push({ ...event.execution });
      return;
    }
    if (event.type === "workflow.execution_finished") {
      const index = this.#executions.findIndex((item) => item.executionId === event.executionId);
      if (index < 0) throw new Error("workflow.execution_finished 指向未知 Execution。 ");
      const execution = this.#executions[index];
      if (execution.finishedAt !== null) throw new Error("WorkflowExecution 不能重复结束。 ");
      const terminal = event.status === "completed" || event.status === "cancelled" || event.status === "interrupted";
      if (!terminal) throw new Error("workflow.execution_finished 必须是终态。 ");
      this.#executions[index] = { ...execution, status: event.status, finishedAt: event.at, diagnostic: event.diagnostic, summary: event.summary };
      return;
    }
    if (event.type === "workflow.execution_resumed") {
      const index = this.#executions.findIndex((item) => item.executionId === event.executionId);
      if (index < 0) throw new Error("workflow.execution_resumed 指向未知 Execution。 ");
      const execution = this.#executions[index];
      if ((execution.status !== "interrupted" && execution.status !== "cancelled") || execution.finishedAt === null) throw new Error("只有已中断或已取消的 WorkflowExecution 可以显式 resume。 ");
      this.#executions[index] = { ...execution, status: "running", finishedAt: null, diagnostic: null, summary: null };
      return;
    }
    if (event.type === "harness.decision_requested") { if (this.#decisions.some((item) => item.decisionId === event.decision.decisionId) || event.decision.answer !== null) throw new Error("Harness 决策请求无效。 "); this.#decisions.push({ ...event.decision }); return; }
    if (event.type === "harness.decision_answered") {
      const index = this.#decisions.findIndex((item) => item.decisionId === event.decisionId);
      if (index < 0) throw new Error("harness.decision_answered 指向未知决策。 ");
      const decision = this.#decisions[index];
      if (decision.answer !== null) throw new Error("Harness 决策不能重复回答。 ");
      validateDecisionAnswer(decision.answerSchema, event.answer);
      this.#decisions[index] = { ...decision, answer: event.answer, answeredAt: event.at };
      return;
    }
  }
  snapshot(): HarnessSnapshot { return { harnessRunId: this.manifest.harnessRunId, projectId: this.manifest.projectId ?? null, cwd: this.manifest.cwd, runtime: this.manifest.runtime ?? null, status: this.#status, diagnostic: this.#diagnostic, completedAt: this.#completedAt, createdAt: this.manifest.createdAt, messages: [...this.#messages], toolActivitiesByMessageId: Object.fromEntries(Object.entries(this.#toolActivitiesByMessageId).map(([messageId, activities]) => [messageId, activities.map((item) => ({ ...item }))])), workflowRevisions: [...this.#workflowRevisions], executions: this.#executions.map((execution) => ({ ...execution })), decisions: this.#decisions.map((decision) => ({ ...decision })) }; }
}

function validateManifest(value: unknown): HarnessManifest {
  if (!plain(value)) throw new Error("Harness manifest 必须是对象。 ");
  const item = value as Record<string, unknown>;
  if (typeof item.harnessRunId !== "string") throw new Error("Harness manifest 缺少 id。 ");
  validateRunId(item.harnessRunId);
  if (!COMPATIBLE_HARNESS_JOURNAL_VERSIONS.includes(item.version as never) || (item.projectId !== undefined && (typeof item.projectId !== "string" || !item.projectId.trim())) || typeof item.cwd !== "string" || !item.cwd.startsWith("/") || typeof item.modelFingerprint !== "string" || !item.modelFingerprint || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt)) || (item.runtime !== undefined && !isRuntimeProvenance(item.runtime))) throw new Error("Harness manifest 无效。 ");
  return item as unknown as HarnessManifest;
}

function validateEvent(value: unknown, harnessRunId: string): HarnessEvent {
  if (!plain(value) || typeof value.type !== "string" || value.harnessRunId !== harnessRunId || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) throw new Error("Harness 事件身份或时间无效。 ");
  const item = value as Record<string, unknown>;
  if (item.type === "harness.created") return item as unknown as HarnessEvent;
  if (item.type === "harness.user_message" || item.type === "harness.assistant_message") { if (!isMessage(item.message, item.type === "harness.user_message" ? "user" : "assistant")) throw new Error("Harness 消息无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.turn_started") { if (typeof item.userMessageId !== "string" || !item.userMessageId.trim()) throw new Error("Harness turn_started 无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.tool_activity") { if (typeof item.messageId !== "string" || !item.messageId.trim() || !Array.isArray(item.activities) || item.activities.length === 0 || item.activities.some((activity) => !isToolActivity(activity))) throw new Error("Harness tool_activity 无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.turn_finished") { if (typeof item.messageId !== "string" || !item.messageId.trim()) throw new Error("Harness turn_finished 无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.turn_interrupted" && typeof item.diagnostic === "string" && item.diagnostic.trim()) return item as unknown as HarnessEvent;
  if (item.type === "harness.completed") return item as unknown as HarnessEvent;
  if (item.type === "workflow.revision_proposed" && isWorkflowRevision(item.revision)) return item as unknown as HarnessEvent;
  if (item.type === "workflow.revision_accepted" && Number.isInteger(item.revision) && (item.revision as number) > 0) return item as unknown as HarnessEvent;
  if (item.type === "workflow.execution_created" && isExecutionRecord(item.execution)) return item as unknown as HarnessEvent;
  if (item.type === "workflow.execution_finished") {
    if (typeof item.executionId !== "string" || !isExecutionStatus(item.status) || (item.diagnostic !== null && typeof item.diagnostic !== "string") || (item.summary !== null && !isJsonObject(item.summary))) throw new Error("Harness 事件类型或字段无效。 ");
    return item as unknown as HarnessEvent;
  }
  if (item.type === "workflow.execution_resumed" && typeof item.executionId === "string" && item.executionId.trim()) return item as unknown as HarnessEvent;
  if (item.type === "harness.decision_requested" && isDecision(item.decision)) return item as unknown as HarnessEvent;
  if (item.type === "harness.decision_answered" && typeof item.decisionId === "string" && item.decisionId.trim() && isJsonObject(item.answer)) return item as unknown as HarnessEvent;
  throw new Error("Harness 事件类型或字段无效。 ");
}

function isMessage(value: unknown, role: HarnessMessage["role"]): value is HarnessMessage { return plain(value) && value.role === role && typeof value.id === "string" && value.id.trim() !== "" && typeof value.text === "string" && value.text.trim() !== "" && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)); }
function isToolActivity(value: unknown): value is HarnessToolActivity { return plain(value) && typeof value.label === "string" && value.label.trim() !== "" && typeof value.finishedAt === "string" && !Number.isNaN(Date.parse(value.finishedAt)) && (value.outcome === "completed" || value.outcome === "failed") && Object.keys(value).every((key) => key === "label" || key === "finishedAt" || key === "outcome"); }
function isWorkflowRevision(value: unknown): value is WorkflowRevision { return plain(value) && Number.isInteger(value.revision) && (value.revision as number) > 0 && typeof value.source === "string" && value.source.length > 0 && value.source.length <= 200_000 && /^[a-f0-9]{64}$/i.test(String(value.sourceHash)) && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && value.acceptedAt === null; }
function isExecutionStatus(value: unknown): value is WorkflowExecutionRecord["status"] { return value === "running" || value === "pausing" || value === "paused" || value === "recovering" || value === "completed" || value === "cancelled" || value === "interrupted"; }
function isPolicy(value: unknown): boolean { return plain(value) && Number.isInteger(value.maxNodes) && (value.maxNodes as number) >= 1 && Number.isInteger(value.maxPhaseVisits) && (value.maxPhaseVisits as number) >= 1 && Number.isInteger(value.maxGates) && (value.maxGates as number) >= 1; }
function isExecutionRecord(value: unknown): value is WorkflowExecutionRecord {
  if (!plain(value) || typeof value.executionId !== "string") return false;
  try { validateRunId(value.executionId); } catch { return false; }
  return Number.isInteger(value.revision) && (value.revision as number) > 0 && /^[a-f0-9]{64}$/i.test(String(value.sourceHash)) && Number.isInteger(value.runtimeVersion) && isPolicy(value.policy) && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && isExecutionStatus(value.status) && (value.finishedAt === null || typeof value.finishedAt === "string") && (value.diagnostic === null || typeof value.diagnostic === "string") && (value.summary === null || isJsonObject(value.summary)) && (value.config === undefined || isExecutionConfigSnapshot(value.config));
}
/** Worker 指派的耐久形状校验；严格失败即拒绝重开，绝不容忍被篡改的分配快照。 */
function isWorkerAssignment(value: unknown): value is import("./types").WorkerAssignment {
  if (!plain(value)) return false;
  return typeof value.agentId === "string" && value.agentId.trim() !== "" && (value.cli === "codex" || value.cli === "kimi") && value.model === "cli-default" && (value.source === "harness-cli" || value.source === "random" || value.source === "rule" || value.source === "literal-cli") && typeof value.runtimeId === "string" && value.runtimeId.trim() !== "" && (value.adapterId === "codex-acp" || value.adapterId === "kimi-acp") && typeof value.adapterVersion === "string" && value.adapterVersion.trim() !== "";
}
/** 执行配置快照的耐久形状校验；只验证结构，语义（runtime 已验证、id 已枚举）由创建路径保证。 */
function isExecutionConfigSnapshot(value: unknown): value is import("./types").ExecutionConfigSnapshot {
  if (!plain(value)) return false;
  if (value.version !== 1 || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)) || typeof value.fallbackRuntimeId !== "string" || !value.fallbackRuntimeId.trim() || (value.ruleText !== null && typeof value.ruleText !== "string") || typeof value.ruleDegraded !== "boolean" || !Array.isArray(value.assignments)) return false;
  if (!isWorkerAssignment(value.defaultAssignment)) return false;
  const ids = new Set<string>();
  for (const assignment of value.assignments) {
    if (!isWorkerAssignment(assignment)) return false;
    if (ids.has(assignment.agentId)) return false;
    ids.add(assignment.agentId);
  }
  return true;
}
function isDecision(value: unknown): value is HarnessDecision { return plain(value) && typeof value.decisionId === "string" && value.decisionId.trim() !== "" && typeof value.question === "string" && value.question.trim() !== "" && (value.answerSchema === undefined || isJsonObject(value.answerSchema)) && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && value.answer === null && value.answeredAt === null; }
function isRuntimeProvenance(value: unknown): value is RuntimeProvenance { return plain(value) && typeof value.runtimeId === "string" && !!value.runtimeId && (value.cli === "codex" || value.cli === "kimi") && typeof value.executablePath === "string" && value.executablePath.startsWith("/") && typeof value.version === "string" && !!value.version && (value.adapterId === "codex-acp" || value.adapterId === "kimi-acp") && typeof value.adapterVersion === "string" && !!value.adapterVersion && typeof value.verifiedAt === "string" && !Number.isNaN(Date.parse(value.verifiedAt)); }
/** 主控决策答案的 Schema 校验；与 Run 决策门共用同一套 Ajv 纪律。 */
function validateDecisionAnswer(schema: JsonObject | undefined, answer: JsonObject): void {
  if (!schema) return;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validator = ajv.compile(schema);
  if (!validator(answer)) throw new Error(`Harness 决策答案不符合 answerSchema：${ajv.errorsText(validator.errors)}`);
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function isTruncatedTail(line: string): boolean { return line.trim().startsWith("{"); }
async function ensureHome(root: string, create = true): Promise<void> { if (resolve(root) !== resolve(harnessRunsRoot())) return; if (create) await ensurePrivateDirectory(waveFlowHome()); else await assertPrivateDirectory(waveFlowHome()); }
async function ensurePrivateDirectory(path: string): Promise<void> { const created = await mkdir(path, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(path); if (created !== undefined) await chmod(path, 0o700); }
async function assertPrivateDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Harness 状态目录必须是真实目录。 "); if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Harness 状态目录不属于当前用户。 "); if ((info.mode & 0o077) !== 0) throw new Error("Harness 状态目录权限过宽。 "); }
async function assertPrivateFile(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Harness 状态文件必须是常规文件。 "); if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Harness 状态文件不属于当前用户。 "); if ((info.mode & 0o077) !== 0) throw new Error("Harness 状态文件权限过宽。 "); }
/** 以 O_NOFOLLOW 打开并在同一 fd 上复核身份后追加，避免 Journal 写入被路径替换重定向。 */
async function appendPrivateJournalLine(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || typeof process.getuid === "function" && info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Harness Journal 文件权限或类型不安全。 ");
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}
async function writePrivateFile(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o600);
}
async function atomicWrite(path: string, text: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await ensurePrivateDirectory(dirname(path));
  await rename(temporary, path);
  await chmod(path, 0o600);
}
