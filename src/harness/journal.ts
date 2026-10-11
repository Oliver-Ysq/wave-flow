import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { harnessRunDirectory, harnessRunsRoot, validateRunId, waveFlowHome } from "../journal/paths";
import type { HarnessMessage, HarnessSnapshot, HarnessStatus, WorkflowRevision } from "./types";

/** 独立 Harness 档案格式；不影响既有 Workflow Run Journal 版本。 */
export const HARNESS_JOURNAL_VERSION = 1;

export type HarnessManifest = {
  readonly harnessRunId: string;
  readonly version: 1;
  readonly cwd: string;
  readonly modelFingerprint: string;
  readonly createdAt: string;
};

type HarnessEvent =
  | { readonly type: "harness.created"; readonly at: string; readonly harnessRunId: string }
  | { readonly type: "harness.user_message"; readonly at: string; readonly harnessRunId: string; readonly message: HarnessMessage }
  | { readonly type: "harness.turn_started"; readonly at: string; readonly harnessRunId: string; readonly userMessageId: string }
  | { readonly type: "harness.assistant_message"; readonly at: string; readonly harnessRunId: string; readonly message: HarnessMessage }
  | { readonly type: "harness.turn_finished"; readonly at: string; readonly harnessRunId: string; readonly messageId: string }
  | { readonly type: "harness.turn_interrupted"; readonly at: string; readonly harnessRunId: string; readonly diagnostic: string }
  | { readonly type: "workflow.revision_proposed"; readonly at: string; readonly harnessRunId: string; readonly revision: WorkflowRevision }
  | { readonly type: "workflow.revision_accepted"; readonly at: string; readonly harnessRunId: string; readonly revision: number };

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
  #messages: HarnessMessage[] = [];
  #turnUserMessageId: string | null = null;
  #assistantMessageId: string | null = null;
  #workflowRevisions: WorkflowRevision[] = [];
  constructor(private readonly manifest: HarnessManifest) {}
  apply(event: HarnessEvent): void {
    if (event.harnessRunId !== this.manifest.harnessRunId) throw new Error("Harness 事件不属于当前会话。 ");
    if (!this.#created && event.type !== "harness.created") throw new Error("Harness 首条事件必须是 created。 ");
    if (event.type === "harness.created") { if (this.#created) throw new Error("Harness created 重复。 "); this.#created = true; return; }
    if (event.type === "harness.user_message") { if (this.#status === "running") throw new Error("Harness 回合运行中不能追加用户消息。 "); this.#messages.push(event.message); this.#status = "idle"; this.#diagnostic = null; return; }
    if (event.type === "harness.turn_started") { if (this.#status === "running" || this.#messages.at(-1)?.id !== event.userMessageId) throw new Error("Harness turn_started 不匹配最新用户消息。 "); this.#status = "running"; this.#turnUserMessageId = event.userMessageId; return; }
    if (event.type === "harness.assistant_message") { if (this.#status !== "running" || event.message.role !== "assistant" || this.#assistantMessageId) throw new Error("Harness assistant_message 不合法。 "); this.#messages.push(event.message); this.#assistantMessageId = event.message.id; return; }
    if (event.type === "harness.turn_finished") { if (this.#status !== "running" || this.#assistantMessageId !== event.messageId) throw new Error("Harness turn_finished 缺少完整 assistant 消息。 "); this.#status = "idle"; this.#turnUserMessageId = null; this.#assistantMessageId = null; return; }
    if (event.type === "harness.turn_interrupted") { if (this.#status !== "running") throw new Error("Harness turn_interrupted 必须来自运行中回合。 "); this.#status = "interrupted"; this.#diagnostic = event.diagnostic; this.#turnUserMessageId = null; this.#assistantMessageId = null; return; }
    if (event.type === "workflow.revision_proposed") { if (this.#workflowRevisions.length + 1 !== event.revision.revision || event.revision.acceptedAt !== null) throw new Error("Workflow revision 序号或状态无效。 "); this.#workflowRevisions.push(event.revision); return; }
    if (event.type === "workflow.revision_accepted") { const revision = this.#workflowRevisions.at(-1); if (!revision || revision.revision !== event.revision || revision.acceptedAt !== null) throw new Error("Workflow revision 只能按最新未接受草案冻结。 "); this.#workflowRevisions[this.#workflowRevisions.length - 1] = { ...revision, acceptedAt: event.at }; return; }
  }
  snapshot(): HarnessSnapshot { return { harnessRunId: this.manifest.harnessRunId, cwd: this.manifest.cwd, status: this.#status, diagnostic: this.#diagnostic, createdAt: this.manifest.createdAt, messages: [...this.#messages], workflowRevisions: [...this.#workflowRevisions] }; }
}

function validateManifest(value: unknown): HarnessManifest {
  if (!plain(value)) throw new Error("Harness manifest 必须是对象。 ");
  const item = value as Record<string, unknown>;
  if (typeof item.harnessRunId !== "string") throw new Error("Harness manifest 缺少 id。 ");
  validateRunId(item.harnessRunId);
  if (item.version !== HARNESS_JOURNAL_VERSION || typeof item.cwd !== "string" || !item.cwd.startsWith("/") || typeof item.modelFingerprint !== "string" || !item.modelFingerprint || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))) throw new Error("Harness manifest 无效。 ");
  return item as unknown as HarnessManifest;
}

function validateEvent(value: unknown, harnessRunId: string): HarnessEvent {
  if (!plain(value) || typeof value.type !== "string" || value.harnessRunId !== harnessRunId || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) throw new Error("Harness 事件身份或时间无效。 ");
  const item = value as Record<string, unknown>;
  if (item.type === "harness.created") return item as unknown as HarnessEvent;
  if (item.type === "harness.user_message" || item.type === "harness.assistant_message") { if (!isMessage(item.message, item.type === "harness.user_message" ? "user" : "assistant")) throw new Error("Harness 消息无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.turn_started") { if (typeof item.userMessageId !== "string" || !item.userMessageId.trim()) throw new Error("Harness turn_started 无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.turn_finished") { if (typeof item.messageId !== "string" || !item.messageId.trim()) throw new Error("Harness turn_finished 无效。 "); return item as unknown as HarnessEvent; }
  if (item.type === "harness.turn_interrupted" && typeof item.diagnostic === "string" && item.diagnostic.trim()) return item as unknown as HarnessEvent;
  if (item.type === "workflow.revision_proposed" && isWorkflowRevision(item.revision)) return item as unknown as HarnessEvent;
  if (item.type === "workflow.revision_accepted" && Number.isInteger(item.revision) && (item.revision as number) > 0) return item as unknown as HarnessEvent;
  throw new Error("Harness 事件类型或字段无效。 ");
}

function isMessage(value: unknown, role: HarnessMessage["role"]): value is HarnessMessage { return plain(value) && value.role === role && typeof value.id === "string" && value.id.trim() !== "" && typeof value.text === "string" && value.text.trim() !== "" && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)); }
function isWorkflowRevision(value: unknown): value is WorkflowRevision { return plain(value) && Number.isInteger(value.revision) && (value.revision as number) > 0 && typeof value.source === "string" && value.source.length > 0 && value.source.length <= 200_000 && /^[a-f0-9]{64}$/i.test(String(value.sourceHash)) && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && value.acceptedAt === null; }
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
