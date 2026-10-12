import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { HARNESS_JOURNAL_VERSION, HarnessJournal, HarnessProjection, type HarnessManifest } from "./journal";
import { PiHarnessSession, type HarnessPiSession } from "./pi-harness";
import { harnessConfigStatus, loadHarnessConfig, type ResolvedHarnessModelConfig } from "./config";
import type { HarnessDecision, HarnessMessage, HarnessSnapshot, HarnessStreamEvent, WorkflowExecutionRecord } from "./types";
import { harnessRunsRoot, validateRunId } from "../journal/paths";
import type { JsonObject } from "../shared/json";
import type { HarnessActionCallbacks } from "./action-tools";

/** daemon 内 Harness 服务；不导入 Runtime、Control、Executor 或 Adapter。 */
export class HarnessService {
  #sessions = new Map<string, { readonly journal: HarnessJournal; readonly projection: HarnessProjection; pi: HarnessPiSession | null; readonly listeners: Set<(event: HarnessStreamEvent) => void>; turn: Promise<void> | null }>();
  /** 同一 Harness 的 Journal 状态变更必须串行；不同 Harness 仍可并行。 */
  #mutations = new Map<string, Promise<void>>();
  /** 回合内 request_user_decision 的等待者；键为 harnessRunId:decisionId。 */
  #decisionWaiters = new Map<string, { readonly resolve: (answer: JsonObject) => void; readonly reject: (error: Error) => void }>();
  #modelGeneration = 0;
  constructor(
    private readonly root = harnessRunsRoot(),
    private readonly resolveModel: () => Promise<ResolvedHarnessModelConfig | null> = loadHarnessConfig,
    private readonly createPi: (config: ResolvedHarnessModelConfig, cwd: string, prior: readonly HarnessMessage[], actions: HarnessActionCallbacks) => HarnessPiSession = (config, cwd, prior, actions) => new PiHarnessSession(config, cwd, "你是 Wave Flow 主控。对于项目、代码、Git 或 CLI 事实，必须使用 read_project_file 或 query_project。你只能通过已注册窄工具提出 workflow 草案、查看 Execution/capsule 或请求用户决策；禁止写入文件、执行写 Shell、直接创建 Worker、直接执行 Workflow，或声称任务已完成。propose_workflow_revision 只提交草案，必须由用户明确接受后才可能创建 Execution；没有任何 complete、节点创建或状态伪造工具。普通工具错误和环境问题应自行处理，不能滥用 request_user_decision。", prior, actions),
  ) {}

  /** 在已验证项目 cwd 内创建会话；projectId 只由 Project Store 提供。 */
  async create(cwd: string, projectId = "test-project"): Promise<HarnessSnapshot> {
    const resolvedCwd = await realpath(cwd).catch(() => { throw new Error("Harness cwd 不可验证。 "); });
    const config = await this.resolveModel();
    if (!config) throw new Error("Harness 尚未配置模型。请在桌面端填写 OpenAI-compatible 服务地址、模型和 API Key。 ");
    if (!projectId.trim()) throw new Error("Harness 必须归属已验证项目。 ");
    const manifest: HarnessManifest = { harnessRunId: crypto.randomUUID(), projectId, version: HARNESS_JOURNAL_VERSION, cwd: resolvedCwd, modelFingerprint: createHash("sha256").update(`${config.model}\n${config.baseUrl}`).digest("hex"), createdAt: new Date().toISOString() };
    const journal = await HarnessJournal.create(manifest, this.root);
    const opened = await HarnessJournal.open(manifest.harnessRunId, this.root);
    const entry = { journal, projection: new HarnessProjection(manifest), pi: null, listeners: new Set<(event: HarnessStreamEvent) => void>(), turn: null };
    for (const event of opened.events) entry.projection.apply(event);
    this.#sessions.set(manifest.harnessRunId, entry);
    return entry.projection.snapshot();
  }

  /**
   * 新会话的唯一持久化入口：浏览器中的草稿不调用此方法。
   * 只有首条有效消息已经由用户明确发送时，才创建私有档案并启动主控回合。
   */
  async start(cwd: string, projectId: string, text: string): Promise<HarnessSnapshot> {
    if (!text.trim() || text.length > 20_000) throw new Error("Harness 消息必须为 1-20000 个字符。 ");
    const created = await this.create(cwd, projectId);
    await this.send(created.harnessRunId, text);
    return this.snapshot(created.harnessRunId);
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
    const actions = this.actionCallbacks(harnessRunId);
    const pi = entry.pi && stored.piGeneration === this.#modelGeneration ? entry.pi : this.createPi(config, entry.projection.snapshot().cwd, entry.projection.snapshot().messages, actions);
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
      } finally {
        // request_user_decision 的等待者只属于当前 Pi 回合。若 provider/用户中断
        // 而不释放它，后续 Harness 会永久卡在一个已无人消费的 Promise 上。
        this.rejectDecisionWaiters(harnessRunId, "Harness 主控回合已结束，无法再接收该决策答案。 ");
        unsubscribe();
        entry.turn = null;
      }
    })();
    });
  }

  async abort(harnessRunId: string): Promise<void> {
    const entry = await this.entry(harnessRunId);
    if (!entry.turn || !entry.pi?.isRunning) throw new Error("Harness 当前没有可取消回合。 ");
    // Pi 的 abort 不保证第三方工具实现会自行响应 AbortSignal；先拒绝本服务
    // 管理的 decision waiter，确保 prompt() 可回到 turn 的 interrupted 收敛路径。
    this.rejectDecisionWaiters(harnessRunId, "用户已停止 Harness 主控回合。 ");
    entry.pi.abort();
  }
  async configStatus() { return harnessConfigStatus(); }
  /** 模型设置更新后，后续回合必须从耐久 capsule 以新配置重建 Pi。 */
  invalidateModelSessions(): void { this.#modelGeneration += 1; for (const entry of this.#sessions.values()) if (!entry.turn) entry.pi = null; }
  /** 创建新的不可变 workflow.ts 草案；它不是 Run，也不启动任何 Worker。 */
  async proposeWorkflowRevision(harnessRunId: string, source: string): Promise<HarnessSnapshot> {
    if (!source.trim() || source.length > 200_000) throw new Error("Workflow 草案必须为 1-200000 个字符。 ");
    return this.mutate(harnessRunId, async () => {
      const entry = await this.entry(harnessRunId);
      if (entry.projection.snapshot().status === "running") throw new Error("主控回合运行中不能修改 Workflow 草案。 ");
      return this.appendWorkflowRevision(harnessRunId, entry, source);
    });
  }

  /**
   * 当前 Pi 回合调用的唯一草案写入口。它已经在 send() 的串行 mutation 中，
   * 因此不能再调用 public proposeWorkflowRevision() 排到本回合之后；否则工具
   * 会等待自己的 turn 结束而死锁。用户 API 仍在 running 时拒绝直接修改草案。
   */
  private async proposeWorkflowRevisionFromAction(harnessRunId: string, source: string): Promise<HarnessSnapshot> {
    if (!source.trim() || source.length > 200_000) throw new Error("Workflow 草案必须为 1-200000 个字符。 ");
    const entry = await this.entry(harnessRunId);
    if (!entry.turn || entry.projection.snapshot().status !== "running") throw new Error("仅当前主控回合可以提交 Workflow 草案。 ");
    return this.appendWorkflowRevision(harnessRunId, entry, source);
  }

  /** 同一 Journal 追加实现由用户 API 与受控主控工具共享，避免 revision 规则漂移。 */
  private async appendWorkflowRevision(harnessRunId: string, entry: Awaited<ReturnType<HarnessService["entry"]>>, source: string): Promise<HarnessSnapshot> {
    const revision: import("./types").WorkflowRevision = { revision: entry.projection.snapshot().workflowRevisions.length + 1, source, sourceHash: createHash("sha256").update(source).digest("hex"), createdAt: new Date().toISOString(), acceptedAt: null };
    const event = { type: "workflow.revision_proposed" as const, at: revision.createdAt, harnessRunId, revision };
    await entry.journal.append(event); entry.projection.apply(event);
    return entry.projection.snapshot();
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

  /** 登记一次 WorkflowExecution 创建；顺序唯一活跃与 revision 冻结由 Projection 强制。 */
  async recordExecutionCreated(harnessRunId: string, execution: WorkflowExecutionRecord): Promise<HarnessSnapshot> {
    return this.mutate(harnessRunId, async () => {
      const entry = await this.entry(harnessRunId);
      const event = { type: "workflow.execution_created" as const, at: execution.createdAt, harnessRunId, execution };
      await entry.journal.append(event); entry.projection.apply(event);
      this.emit(entry, { type: "execution_changed", executionId: execution.executionId });
      return entry.projection.snapshot();
    });
  }

  /** 登记一次 WorkflowExecution 终态；summary 是脚本 run() 的 JSON 返回值摘要。 */
  async recordExecutionFinished(harnessRunId: string, executionId: string, status: WorkflowExecutionRecord["status"], diagnostic: string | null, summary: JsonObject | null): Promise<void> {
    await this.mutate(harnessRunId, async () => {
      const entry = await this.entry(harnessRunId);
      const event = { type: "workflow.execution_finished" as const, at: new Date().toISOString(), harnessRunId, executionId, status, diagnostic, summary };
      await entry.journal.append(event); entry.projection.apply(event);
      this.emit(entry, { type: "execution_changed", executionId });
    });
  }

  /** Execution 内部状态变化（gate、暂停等）的展示通知；展示层随后回读快照，不以本事件为状态依据。 */
  async notifyExecutionChanged(harnessRunId: string, executionId: string): Promise<void> {
    const entry = await this.entry(harnessRunId);
    this.emit(entry, { type: "execution_changed", executionId });
  }

  /**
   * 主控窄工具 request_user_decision：先耐久请求再等待答案。
   * 答案经独立 API 在回合运行中写入，不经过 mutation 锁，避免与工具等待互相死锁。
   */
  async requestUserDecision(harnessRunId: string, question: string, answerSchema?: JsonObject): Promise<JsonObject> {
    const entry = await this.entry(harnessRunId);
    if (typeof question !== "string" || !question.trim()) throw new Error("决策请求必须包含非空问题。 ");
    const decision: HarnessDecision = { decisionId: crypto.randomUUID(), question, answerSchema, createdAt: new Date().toISOString(), answer: null, answeredAt: null };
    const event = { type: "harness.decision_requested" as const, at: decision.createdAt, harnessRunId, decision };
    await entry.journal.append(event); entry.projection.apply(event);
    const key = `${harnessRunId}:${decision.decisionId}`;
    return new Promise<JsonObject>((resolve, reject) => {
      this.#decisionWaiters.set(key, { resolve, reject });
    });
  }

  /** 用户提交决策答案；durable-first 写入后只唤醒原工具调用，不推进任何其他状态。 */
  async answerUserDecision(harnessRunId: string, decisionId: string, answer: JsonObject): Promise<HarnessSnapshot> {
    const entry = await this.entry(harnessRunId);
    const decision = entry.projection.snapshot().decisions.find((item) => item.decisionId === decisionId);
    if (!decision) throw new Error("未知 Harness 决策请求。 ");
    if (decision.answer !== null) throw new Error("Harness 决策不能重复回答。 ");
    const event = { type: "harness.decision_answered" as const, at: new Date().toISOString(), harnessRunId, decisionId, answer };
    // Projection.apply 会按 answerSchema 重新校验；先追加失败则答案不落盘也不唤醒。
    await entry.journal.append(event);
    entry.projection.apply(event);
    const key = `${harnessRunId}:${decisionId}`;
    const waiter = this.#decisionWaiters.get(key);
    if (waiter) {
      this.#decisionWaiters.delete(key);
      waiter.resolve(answer);
    }
    return entry.projection.snapshot();
  }

  /** 为当前 Harness 绑定最小行动面；每项仍回到本服务做耐久校验。 */
  private actionCallbacks(harnessRunId: string): HarnessActionCallbacks {
    return {
      proposeWorkflowRevision: async (source) => {
        const snapshot = await this.proposeWorkflowRevisionFromAction(harnessRunId, source);
        const revision = snapshot.workflowRevisions.at(-1);
        if (!revision) throw new Error("Workflow 草案未能耐久。 ");
        return { revision: revision.revision, sourceHash: revision.sourceHash };
      },
      inspectExecution: async (executionId) => {
        const snapshot = await this.snapshot(harnessRunId);
        const executions = executionId ? snapshot.executions.filter((item) => item.executionId === executionId) : snapshot.executions;
        if (executionId && executions.length === 0) throw new Error("未知 WorkflowExecution。 ");
        return executions;
      },
      readRunCapsule: async () => this.snapshot(harnessRunId),
      requestUserDecision: async (question, answerSchema) => this.requestUserDecision(harnessRunId, question, answerSchema),
    };
  }
  /** 拒绝一个 Harness 当前回合遗留的全部决策等待者；不篡改已经耐久的审计事实。 */
  private rejectDecisionWaiters(harnessRunId: string, diagnostic: string): void {
    const prefix = `${harnessRunId}:`;
    for (const [key, waiter] of this.#decisionWaiters) {
      if (!key.startsWith(prefix)) continue;
      this.#decisionWaiters.delete(key);
      waiter.reject(new Error(diagnostic));
    }
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
