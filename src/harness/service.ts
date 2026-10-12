import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { HARNESS_JOURNAL_VERSION, HarnessJournal, HarnessProjection, type HarnessManifest } from "./journal";
import type { HarnessSession } from "./session";
import type { HarnessDecision, HarnessMessage, HarnessSnapshot, HarnessStreamEvent, WorkflowExecutionRecord } from "./types";
import { harnessRunsRoot, validateRunId } from "../journal/paths";
import type { JsonObject } from "../shared/json";
import type { HarnessActionCallbacks } from "./action-tools";
import { executeReadOnlyProjectQuery, readProjectFile } from "./shell-policy";
import { type HarnessPiSession } from "./pi-harness";
import type { ResolvedHarnessModelConfig } from "./config";

/** daemon 内 Harness 服务；不导入 Runtime、Control、Executor 或 Adapter。 */
export class HarnessService {
  #sessions = new Map<string, { readonly journal: HarnessJournal; readonly projection: HarnessProjection; session: HarnessSession | null; readonly listeners: Set<(event: HarnessStreamEvent) => void>; turn: Promise<void> | null }>();
  /** 同一 Harness 的 Journal 状态变更必须串行；不同 Harness 仍可并行。 */
  #mutations = new Map<string, Promise<void>>();
  /** 回合内 request_user_decision 的等待者；键为 harnessRunId:decisionId。 */
  #decisionWaiters = new Map<string, { readonly resolve: (answer: JsonObject) => void; readonly reject: (error: Error) => void }>();
  constructor(
    private readonly root = harnessRunsRoot(),
    factoryOrResolve: ((harnessRunId: string, cwd: string, prior: readonly HarnessMessage[], actions: HarnessActionCallbacks, runtime?: import("../runtimes/types").RuntimeProvenance) => Promise<HarnessSession>) | (() => Promise<ResolvedHarnessModelConfig | null>),
    legacyCreate?: (config: ResolvedHarnessModelConfig, cwd: string, prior: readonly HarnessMessage[], actions: HarnessActionCallbacks) => HarnessPiSession,
    private readonly resolveSessionIdentity: () => Promise<{ readonly fingerprint: string; readonly runtime?: import("../runtimes/types").RuntimeProvenance }> = async () => ({ fingerprint: "injected-harness-session" }),
  ) {
    if (legacyCreate) {
      const resolve = factoryOrResolve as () => Promise<ResolvedHarnessModelConfig | null>;
      this.createSession = async (_id, cwd, prior, actions) => {
        const config = await resolve();
        if (!config) throw new Error("主控未配置模型。 ");
        return legacyCreate(config, cwd, prior, actions);
      };
    } else this.createSession = factoryOrResolve as (harnessRunId: string, cwd: string, prior: readonly HarnessMessage[], actions: HarnessActionCallbacks, runtime?: import("../runtimes/types").RuntimeProvenance) => Promise<HarnessSession>;
  }

  private readonly createSession: (harnessRunId: string, cwd: string, prior: readonly HarnessMessage[], actions: HarnessActionCallbacks, runtime?: import("../runtimes/types").RuntimeProvenance) => Promise<HarnessSession>;

  /** 在已验证项目 cwd 内创建会话；projectId 只由 Project Store 提供。 */
  async create(cwd: string, projectId = "test-project"): Promise<HarnessSnapshot> {
    const resolvedCwd = await realpath(cwd).catch(() => { throw new Error("Harness cwd 不可验证。 "); });
    if (!projectId.trim()) throw new Error("Harness 必须归属已验证项目。 ");
    const identity = await this.resolveSessionIdentity(); const modelFingerprint = identity.fingerprint;
    if (!/^[a-f0-9]{64}$/i.test(modelFingerprint) && modelFingerprint !== "injected-harness-session") throw new Error("Harness session fingerprint 无效。 ");
    const manifest: HarnessManifest = { harnessRunId: crypto.randomUUID(), projectId, version: HARNESS_JOURNAL_VERSION, cwd: resolvedCwd, modelFingerprint, ...(identity.runtime ? { runtime: identity.runtime } : {}), createdAt: new Date().toISOString() };
    const journal = await HarnessJournal.create(manifest, this.root);
    const opened = await HarnessJournal.open(manifest.harnessRunId, this.root);
    const entry = { journal, projection: new HarnessProjection(manifest), session: null, listeners: new Set<(event: HarnessStreamEvent) => void>(), turn: null };
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

  /** daemon 关闭时释放全部原生主控会话与未答决策；不改写任何 Journal 业务状态。 */
  close(): void {
    for (const [harnessRunId, entry] of this.#sessions) {
      this.rejectDecisionWaiters(harnessRunId, "daemon 已关闭，Harness 主控决策不再等待。 ");
      entry.session?.close?.();
      entry.session = null;
    }
  }

  async send(harnessRunId: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 20_000) throw new Error("Harness 消息必须为 1-20000 个字符。 ");
    const entry = await this.entry(harnessRunId);
    await this.mutate(harnessRunId, async () => {
    if (entry.projection.snapshot().status === "running" || entry.turn) throw new Error("Harness 当前回合仍在运行。 ");
    const actions = this.actionCallbacks(harnessRunId);
    const session = entry.session ?? await this.createSession(harnessRunId, entry.projection.snapshot().cwd, entry.projection.snapshot().messages, actions, entry.journal.manifest.runtime);
    entry.session = session;
    const user: HarnessMessage = { id: crypto.randomUUID(), role: "user", text, createdAt: new Date().toISOString() };
    const userEvent = { type: "harness.user_message" as const, at: user.createdAt, harnessRunId, message: user };
    await entry.journal.append(userEvent); entry.projection.apply(userEvent);
    const started = { type: "harness.turn_started" as const, at: new Date().toISOString(), harnessRunId, userMessageId: user.id };
    await entry.journal.append(started); entry.projection.apply(started);
    const unsubscribe = session.subscribe((event) => { for (const listener of entry.listeners) listener(event); });
    entry.turn = (async () => {
      try {
        const answer = await session.prompt(text);
        const assistant: HarnessMessage = { id: crypto.randomUUID(), role: "assistant", text: stripReasoning(answer), createdAt: new Date().toISOString() };
        if (!assistant.text.trim()) throw new Error("主控回答只包含非持久 reasoning。 ");
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
        // 已耐久 capsule 重建独立 ACP session，避免未完成文本/工具调用进入新回合。
        entry.session?.close?.();
        entry.session = null;
        this.emit(entry, { type: "turn_interrupted", diagnostic });
      } finally {
        // request_user_decision 的等待者只属于当前主控回合。若 adapter/用户中断
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
    if (!entry.turn || !entry.session?.isRunning) throw new Error("Harness 当前没有可取消回合。 ");
    // ACP cancel 不保证第三方工具实现会自行响应 AbortSignal；先拒绝本服务
    // 管理的 decision waiter，确保 prompt() 可回到 turn 的 interrupted 收敛路径。
    this.rejectDecisionWaiters(harnessRunId, "用户已停止 Harness 主控回合。 ");
    entry.session.abort();
  }
  /** 私有 MCP sidecar 的唯一工具入口；所有 action 仍回到本服务做耐久校验。 */
  async mcpTools(harnessRunId: string, request: { readonly operation: "list" | "call"; readonly value: Record<string, unknown> }): Promise<unknown> {
    const entry = await this.entry(harnessRunId);
    if (request.operation === "list") return { tools: [
      { name: "read_project_file", description: "读取当前项目内常规文件片段", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } } } },
      { name: "query_project", description: "执行受限只读项目查询", inputSchema: { type: "object", required: ["command", "args"], properties: { command: { enum: ["pwd", "git", "rg", "ls"] }, args: { type: "array", items: { type: "string" } } } } },
      { name: "propose_workflow_revision", description: "提交 workflow 草案，不执行", inputSchema: { type: "object", required: ["source"], properties: { source: { type: "string" } } } },
      { name: "inspect_execution", description: "读取 Execution 登记", inputSchema: { type: "object", properties: { executionId: { type: "string" } } } },
      { name: "read_run_capsule", description: "读取耐久 Harness capsule", inputSchema: { type: "object" } },
      { name: "request_user_decision", description: "请求用户决策", inputSchema: { type: "object", required: ["question"], properties: { question: { type: "string" }, answerSchema: { type: "object" } } } },
    ] };
    const { name, arguments: args = {} } = request.value as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Harness MCP 工具请求无效。 ");
    const value = args as Record<string, unknown>; const actions = this.actionCallbacks(harnessRunId);
    if (name === "read_project_file") return { text: await readProjectFile(entry.projection.snapshot().cwd, { path: String(value.path ?? ""), ...(typeof value.startLine === "number" ? { startLine: value.startLine } : {}), ...(typeof value.endLine === "number" ? { endLine: value.endLine } : {}) }) };
    if (name === "query_project") return { text: await executeReadOnlyProjectQuery(entry.projection.snapshot().cwd, { command: value.command as "pwd" | "git" | "rg" | "ls", args: Array.isArray(value.args) ? value.args.map(String) : [] }) };
    if (name === "propose_workflow_revision") return actions.proposeWorkflowRevision(String(value.source ?? ""));
    if (name === "inspect_execution") return actions.inspectExecution(typeof value.executionId === "string" ? value.executionId : undefined);
    if (name === "read_run_capsule") return actions.readRunCapsule();
    if (name === "request_user_decision") return { answer: await actions.requestUserDecision(String(value.question ?? ""), value.answerSchema && typeof value.answerSchema === "object" && !Array.isArray(value.answerSchema) ? value.answerSchema as JsonObject : undefined) };
    throw new Error(`Harness MCP 工具未获授权：${name}`);
  }
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
   * 当前主控回合调用的唯一草案写入口。它已经在 send() 的串行 mutation 中，
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
    const entry = { journal: opened.journal, projection, session: null, listeners: new Set<(event: HarnessStreamEvent) => void>(), turn: null };
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
