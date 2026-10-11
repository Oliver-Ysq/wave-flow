import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { HarnessJournal, HarnessProjection, type HarnessManifest } from "./journal";
import { PiHarnessSession, type HarnessPiSession } from "./pi-harness";
import { harnessConfigStatus, loadHarnessConfig, type ResolvedHarnessModelConfig } from "./config";
import type { HarnessMessage, HarnessSnapshot, HarnessStreamEvent } from "./types";
import { harnessRunsRoot, validateRunId } from "../journal/paths";

/** daemon 内 Harness 服务；不导入 Runtime、Control、Executor 或 Adapter。 */
export class HarnessService {
  #sessions = new Map<string, { readonly journal: HarnessJournal; readonly projection: HarnessProjection; pi: HarnessPiSession | null; readonly listeners: Set<(event: HarnessStreamEvent) => void>; turn: Promise<void> | null }>();
  /** 同一 Harness 的 Journal 状态变更必须串行；不同 Harness 仍可并行。 */
  #mutations = new Map<string, Promise<void>>();
  #modelGeneration = 0;
  constructor(
    private readonly root = harnessRunsRoot(),
    private readonly resolveModel: () => Promise<ResolvedHarnessModelConfig | null> = loadHarnessConfig,
    private readonly createPi: (config: ResolvedHarnessModelConfig, cwd: string, prior: readonly HarnessMessage[]) => HarnessPiSession = (config, cwd, prior) => new PiHarnessSession(config, cwd, "你是 Wave Flow 的只读主控。对于用户要求确认项目、代码、Git 或 CLI 事实的请求，你必须主动使用 read_project_file 或 query_project；这两种工具是当前唯一获准执行的本机操作。禁止写入文件、执行写操作、创建 Worker、执行 Workflow 或声称任务已完成。工具输出仅是事实依据；不要把“禁止执行”误解为禁止使用已注册的只读工具。", prior),
  ) {}

  async create(cwd: string): Promise<HarnessSnapshot> {
    const resolvedCwd = await realpath(cwd).catch(() => { throw new Error("Harness cwd 不可验证。 "); });
    const config = await this.resolveModel();
    if (!config) throw new Error("Harness 尚未配置模型。请在桌面端填写 OpenAI-compatible 服务地址、模型和 API Key。 ");
    const manifest: HarnessManifest = { harnessRunId: crypto.randomUUID(), version: 1, cwd: resolvedCwd, modelFingerprint: createHash("sha256").update(`${config.model}\n${config.baseUrl}`).digest("hex"), createdAt: new Date().toISOString() };
    const journal = await HarnessJournal.create(manifest, this.root);
    const opened = await HarnessJournal.open(manifest.harnessRunId, this.root);
    const entry = { journal, projection: new HarnessProjection(manifest), pi: null, listeners: new Set<(event: HarnessStreamEvent) => void>(), turn: null };
    for (const event of opened.events) entry.projection.apply(event);
    this.#sessions.set(manifest.harnessRunId, entry);
    return entry.projection.snapshot();
  }

  async snapshot(harnessRunId: string): Promise<HarnessSnapshot> { return (await this.entry(harnessRunId)).projection.snapshot(); }
  /** 列出当前用户已耐久的主控会话；损坏单个档案不影响其他会话。 */
  async list(): Promise<readonly HarnessSnapshot[]> {
    let ids: string[];
    try { ids = await readdir(this.root); } catch { return []; }
    const snapshots = await Promise.all(ids.map(async (id) => {
      try { return await this.snapshot(id); } catch { return null; }
    }));
    return snapshots.filter((item): item is HarnessSnapshot => item !== null).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async subscribe(harnessRunId: string, listener: (event: HarnessStreamEvent) => void): Promise<() => void> { const entry = await this.entry(harnessRunId); entry.listeners.add(listener); return () => entry.listeners.delete(listener); }

  async send(harnessRunId: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 20_000) throw new Error("Harness 消息必须为 1-20000 个字符。 ");
    const entry = await this.entry(harnessRunId);
    await this.mutate(harnessRunId, async () => {
    if (entry.projection.snapshot().status === "running" || entry.turn) throw new Error("Harness 当前回合仍在运行。 ");
    // Pi 上下文只能读取已完成的旧 capsule；当前用户消息由 prompt() 精确追加一次。
    const config = await this.resolveModel();
    if (!config) throw new Error("Harness 尚未配置模型。请先保存模型设置。 ");
    const stored = entry as typeof entry & { piGeneration?: number };
    const pi = entry.pi && stored.piGeneration === this.#modelGeneration ? entry.pi : this.createPi(config, entry.projection.snapshot().cwd, entry.projection.snapshot().messages);
    entry.pi = pi; stored.piGeneration = this.#modelGeneration;
    const user: HarnessMessage = { id: crypto.randomUUID(), role: "user", text, createdAt: new Date().toISOString() };
    const userEvent = { type: "harness.user_message" as const, at: user.createdAt, harnessRunId, message: user };
    await entry.journal.append(userEvent); entry.projection.apply(userEvent);
    const started = { type: "harness.turn_started" as const, at: new Date().toISOString(), harnessRunId, userMessageId: user.id };
    await entry.journal.append(started); entry.projection.apply(started);
    const unsubscribe = pi.subscribe((event) => { for (const listener of entry.listeners) listener(event); });
    entry.turn = (async () => {
      try {
        const answer = await pi.prompt(text);
        const assistant: HarnessMessage = { id: crypto.randomUUID(), role: "assistant", text: stripReasoning(answer), createdAt: new Date().toISOString() };
        if (!assistant.text.trim()) throw new Error("Pi 主控回答只包含非持久 reasoning。 ");
        const messageEvent = { type: "harness.assistant_message" as const, at: assistant.createdAt, harnessRunId, message: assistant };
        await entry.journal.append(messageEvent); entry.projection.apply(messageEvent);
        const finished = { type: "harness.turn_finished" as const, at: new Date().toISOString(), harnessRunId, messageId: assistant.id };
        await entry.journal.append(finished); entry.projection.apply(finished);
        this.emit(entry, { type: "turn_finished", messageId: assistant.id });
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        const interrupted = { type: "harness.turn_interrupted" as const, at: new Date().toISOString(), harnessRunId, diagnostic };
        await entry.journal.append(interrupted); entry.projection.apply(interrupted);
        // 不认领 provider 可能遗留的 partial assistant state。下一条消息只能从
        // 已耐久的 capsule 重建 Pi，避免把未完成文本带入新回合上下文。
        entry.pi = null;
        this.emit(entry, { type: "turn_interrupted", diagnostic });
      } finally { unsubscribe(); entry.turn = null; }
    })();
    });
  }

  async abort(harnessRunId: string): Promise<void> { const entry = await this.entry(harnessRunId); if (!entry.turn || !entry.pi?.isRunning) throw new Error("Harness 当前没有可取消回合。 "); entry.pi.abort(); }
  async configStatus() { return harnessConfigStatus(); }
  /** 模型设置更新后，后续回合必须从耐久 capsule 以新配置重建 Pi。 */
  invalidateModelSessions(): void { this.#modelGeneration += 1; for (const entry of this.#sessions.values()) if (!entry.turn) entry.pi = null; }
  /** 创建新的不可变 workflow.ts 草案；它不是 Run，也不启动任何 Worker。 */
  async proposeWorkflowRevision(harnessRunId: string, source: string): Promise<HarnessSnapshot> {
    if (!source.trim() || source.length > 200_000) throw new Error("Workflow 草案必须为 1-200000 个字符。 ");
    return this.mutate(harnessRunId, async () => {
      const entry = await this.entry(harnessRunId);
      if (entry.projection.snapshot().status === "running") throw new Error("主控回合运行中不能修改 Workflow 草案。 ");
      const revision: import("./types").WorkflowRevision = { revision: entry.projection.snapshot().workflowRevisions.length + 1, source, sourceHash: createHash("sha256").update(source).digest("hex"), createdAt: new Date().toISOString(), acceptedAt: null };
      const event = { type: "workflow.revision_proposed" as const, at: revision.createdAt, harnessRunId, revision };
      await entry.journal.append(event); entry.projection.apply(event);
      return entry.projection.snapshot();
    });
  }
  /** 接受最新草案并冻结其 hash；当前阶段不创建 Run 或执行该代码。 */
  async acceptWorkflowRevision(harnessRunId: string, revision: number): Promise<HarnessSnapshot> {
    return this.mutate(harnessRunId, async () => {
      const entry = await this.entry(harnessRunId);
      if (entry.projection.snapshot().status === "running") throw new Error("主控回合运行中不能接受 Workflow 草案。 ");
      const event = { type: "workflow.revision_accepted" as const, at: new Date().toISOString(), harnessRunId, revision };
      await entry.journal.append(event); entry.projection.apply(event);
      return entry.projection.snapshot();
    });
  }

  private async entry(harnessRunId: string) {
    validateRunId(harnessRunId);
    const existing = this.#sessions.get(harnessRunId); if (existing) return existing;
    const opened = await HarnessJournal.open(harnessRunId, this.root);
    const projection = new HarnessProjection(opened.journal.manifest); for (const event of opened.events) projection.apply(event);
    const entry = { journal: opened.journal, projection, pi: null, listeners: new Set<(event: HarnessStreamEvent) => void>(), turn: null };
    this.#sessions.set(harnessRunId, entry); return entry;
  }
  private emit(entry: { readonly listeners: Set<(event: HarnessStreamEvent) => void> }, event: HarnessStreamEvent): void { for (const listener of entry.listeners) listener(event); }
  private async mutate<T>(harnessRunId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutations.get(harnessRunId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const settled = task.then(() => undefined, () => undefined);
    this.#mutations.set(harnessRunId, settled);
    try { return await task; } finally { if (this.#mutations.get(harnessRunId) === settled) this.#mutations.delete(harnessRunId); }
  }
}

/** 兼容模型把 <think> 内容作为 text 返回；只丢弃其显式 thinking 区段，不记录该内容。 */
function stripReasoning(text: string): string { return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim(); }
