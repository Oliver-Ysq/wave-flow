import type { HarnessConversationEntry, HarnessStreamEvent, HarnessToolEntry, HarnessToolKind } from "./types";
import type { HarnessEvent, HarnessJournal } from "./journal";

/** 正文/思考增量的最长合并窗口；先耐久追加成功，再向界面发布。 */
const COALESCE_MS = 100;
/** 每回合正文保存上限（字节）。 */
const BODY_MAX_BYTES = 256 * 1024;
/** 每回合思考保存上限（字节，跨全部思考段合计）。 */
const THOUGHT_MAX_BYTES = 256 * 1024;
/** 每个工具输出保存上限（字节）。 */
const TOOL_OUTPUT_MAX_BYTES = 32 * 1024;
/** 每回合全部工具输出合计上限（字节）。 */
const TOOL_OUTPUT_TURN_MAX_BYTES = 1024 * 1024;
/** 参数摘要上限（字符）。 */
const PARAMS_MAX_CHARS = 2_000;
/** 目标字段上限（字符）。 */
const TARGET_MAX_CHARS = 1_000;

/** Engine 私有 sidecar 的窄工具注册名；这些调用由执行包装器权威记录，ACP 侧的同名通知视为重复来源而跳过。 */
const ENGINE_MCP_TOOL_NAMES = new Set(["propose_workflow_revision", "inspect_execution", "read_run_capsule", "request_user_decision"]);

/** ACP 对 MCP 工具名的标准编码 `mcp__<server>__<tool>`；仅在完整匹配该形态时还原工具名，不按相似名称猜测。 */
export function unmangleAcpMcpToolName(name: string | null): string | null {
  if (!name) return null;
  const match = /^mcp__[^_][^]*__([^_].*)$/.exec(name);
  return match ? match[1] : name;
}

export type EngineToolStart = {
  /** 服务端固定动作名（中文标签）。 */
  readonly name: string;
  readonly toolKind: HarnessToolKind;
  readonly target: string | null;
  readonly paramsSummary: string | null;
};

export type EngineToolFinish = {
  /** 限长前的原始输出；记录器负责脱敏与截断。 */
  readonly output: string | null;
  readonly exitCode?: number | null;
};

/**
 * 单回合对话事实记录器。条目事件经串行队列先写 Journal，成功后才向界面发布；
 * 正文/思考增量按最长 100ms 窗口合并；正文/思考条目在首个片段落盘时才建立，
 * 因此空思考段不会在回放中留下无内容噪音。回合终结前排空已接收队列；
 * 进程崩溃只承诺回放已落盘部分。
 */
export class TurnConversationRecorder {
  #queue: Promise<void> = Promise.resolve();
  #failure: Error | null = null;
  #closed = false;
  #seq = 0;
  #body: HarnessConversationEntry & { kind: "body" } | null = null;
  #thought: HarnessConversationEntry & { kind: "thought" } | null = null;
  #tools = new Map<string, HarnessToolEntry>();
  #started = new Set<string>();
  #bodyPending = "";
  #thoughtPending = "";
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #bodyBytes = 0;
  #thoughtBytes = 0;
  #toolOutputBytes = 0;

  constructor(
    private readonly journal: HarnessJournal,
    private readonly harnessRunId: string,
    private readonly turnId: string,
    private readonly publish: (event: HarnessStreamEvent) => void,
    /** 耐久成功后同步投影；与服务层 append→apply 纪律一致，保证快照与回放同源。 */
    private readonly applyProjection: (event: HarnessEvent) => void,
  ) {}

  /** 会话流事件入口；只消费正文/思考/ACP 工具事件，其余瞬时事件忽略。 */
  handleStreamEvent(event: HarnessStreamEvent): void {
    if (this.#closed || this.#failure) return;
    if (event.type === "assistant_delta") this.bodyDelta(event.delta);
    else if (event.type === "reasoning_delta") this.thoughtDelta(event.delta);
    else if (event.type === "acp_tool_call") this.acpToolCall(event.call);
    else if (event.type === "acp_tool_update") this.acpToolUpdate(event.callId, event.patch);
  }

  /** assistant 正文增量；到达时结束未关闭的思考段（分段各自计时）。 */
  bodyDelta(delta: string): void {
    if (this.#closed || this.#failure || !delta) return;
    // 先排空既有缓冲：条目建立事件必须按 seq 顺序落盘，不能让后建条目抢先开始。
    this.flush();
    this.finishOpenThought("completed");
    if (!this.#body) {
      this.#body = { kind: "body", entryId: crypto.randomUUID(), turnId: this.turnId, seq: (this.#seq += 1), legacy: false, text: "", completed: false, truncated: false, startedAt: new Date().toISOString(), finishedAt: null };
    }
    this.#bodyPending += delta;
    this.scheduleFlush();
  }

  /** 思考增量；前一段已结束时另建条目，分别计时。思考插入也会切断正文段，保证回放顺序与真实流一致。 */
  thoughtDelta(delta: string): void {
    if (this.#closed || this.#failure || !delta) return;
    this.flush();
    this.finishOpenBody(true);
    if (!this.#thought) {
      this.#thought = { kind: "thought", entryId: crypto.randomUUID(), turnId: this.turnId, seq: (this.#seq += 1), legacy: false, text: "", startedAt: new Date().toISOString(), finishedAt: null, status: "running", truncated: false };
    }
    this.#thoughtPending += delta;
    this.scheduleFlush();
  }

  /** Engine 受控工具开始；立即耐久并发布“运行中”。 */
  engineToolStarted(callId: string, spec: EngineToolStart): void {
    if (this.#closed || this.#failure) return;
    this.flush();
    this.finishOpenThought("completed");
    this.finishOpenBody(true);
    const entry: HarnessToolEntry = { kind: "tool", entryId: crypto.randomUUID(), turnId: this.turnId, seq: (this.#seq += 1), legacy: false, callId, source: "engine-mcp", name: spec.name, toolKind: spec.toolKind, target: clipChars(spec.target, TARGET_MAX_CHARS), paramsSummary: spec.paramsSummary === null ? null : clipChars(redact(spec.paramsSummary), PARAMS_MAX_CHARS), startedAt: new Date().toISOString(), finishedAt: null, status: "running", output: null, outputTruncated: false, exitCode: null, hasDetail: true };
    this.#tools.set(callId, entry);
    this.startEntry(entry);
  }

  /** Engine 受控工具结束；输出限长脱敏后耐久，状态更新不抹掉已保存输出。 */
  engineToolFinished(callId: string, outcome: "completed" | "failed", detail: EngineToolFinish): void {
    if (this.#closed || this.#failure) return;
    const entry = this.#tools.get(callId);
    if (!entry || entry.status !== "running") return;
    const prepared = this.prepareToolOutput(detail.output);
    const finished: HarnessToolEntry = { ...entry, status: outcome, finishedAt: new Date().toISOString(), output: prepared.text, outputTruncated: prepared.truncated, exitCode: detail.exitCode ?? null };
    this.#tools.set(callId, finished);
    this.finishEntry(finished);
  }

  /** ACP 原生工具调用；Engine 窄工具的同名通知（含 mcp__server__tool 编码名）由包装器权威记录，此处跳过避免重复条目。 */
  acpToolCall(call: import("./types").HarnessAcpToolCall): void {
    if (this.#closed || this.#failure) return;
    // CLI 上报时 name 可能缺省、仅 title 携带编码名，两者都必须经同一形态校验。
    const candidates = [call.name, call.title].map(unmangleAcpMcpToolName);
    if (candidates.some((name) => name !== null && ENGINE_MCP_TOOL_NAMES.has(name))) return;
    this.flush();
    this.finishOpenThought("completed");
    this.finishOpenBody(true);
    const entry: HarnessToolEntry = {
      kind: "tool", entryId: crypto.randomUUID(), turnId: this.turnId, seq: (this.#seq += 1), legacy: false, callId: call.callId, source: "acp", name: clipChars(call.title || call.name || "未命名工具", 200) ?? "未命名工具", toolKind: call.toolKind,
      target: clipChars(call.locations[0]?.path ?? null, TARGET_MAX_CHARS),
      paramsSummary: summarizeRaw(call.rawInput, PARAMS_MAX_CHARS), startedAt: new Date().toISOString(), finishedAt: null, status: "running", output: null, outputTruncated: false, exitCode: null, hasDetail: true,
    };
    this.#tools.set(call.callId, entry);
    this.startEntry(entry);
    if (call.status === "completed" || call.status === "failed") this.applyAcpFinish(call.callId, call.status, call.contentText, call.rawOutput);
    else if (call.contentText) this.replaceToolOutput(call.callId, call.contentText);
  }

  /** ACP 工具更新；按调用 ID 归并。ACP content 是整体替换语义，后续快照覆盖而非追加。 */
  acpToolUpdate(callId: string, patch: import("./types").HarnessAcpToolCallPatch): void {
    if (this.#closed || this.#failure) return;
    const entry = this.#tools.get(callId);
    if (!entry || entry.source !== "acp" || entry.status !== "running") return;
    if (patch.status === "completed" || patch.status === "failed") { this.applyAcpFinish(callId, patch.status, patch.contentText ?? null, patch.rawOutput); return; }
    if (patch.contentText) this.replaceToolOutput(callId, patch.contentText);
  }

  /** 立即排空正文/思考缓冲（串行耐久后发布）；条目切换与回合终结前必须调用。 */
  flush(): void {
    this.clearFlushTimer();
    this.flushPending("body");
    this.flushPending("thought");
  }

  /** 回合正常结束：排空缓冲，思考/正文完成，仍 running 的工具诚实标为 interrupted。 */
  async finishTurn(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.flush();
      this.finishOpenThought("completed");
      this.finishOpenBody(true);
      this.interruptLeftoverTools();
    }
    return this.drain();
  }

  /** 回合中断：排空已接收队列，全部未终结条目收敛为 interrupted，正文标记未完成。 */
  async abortTurn(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.flush();
      this.finishOpenThought("interrupted");
      this.finishOpenBody(false);
      this.interruptLeftoverTools();
    }
    return this.drain();
  }

  /** 等待全部已排队耐久操作完成；任一追加失败即抛错，绝不展示“已保存”。 */
  async drain(): Promise<void> {
    await this.#queue;
    if (this.#failure) throw this.#failure;
  }

  private startEntry(entry: HarnessConversationEntry): void {
    if (this.#started.has(entry.entryId)) return;
    this.#started.add(entry.entryId);
    this.enqueue(async () => {
      const event = { type: "harness.entry_started" as const, at: new Date().toISOString(), harnessRunId: this.harnessRunId, entry };
      await this.journal.append(event);
      this.applyProjection(event);
      this.publish({ type: "entry_started", entry });
    });
  }

  private finishEntry(entry: HarnessConversationEntry): void {
    this.enqueue(async () => {
      const event = { type: "harness.entry_finished" as const, at: new Date().toISOString(), harnessRunId: this.harnessRunId, entry };
      await this.journal.append(event);
      this.applyProjection(event);
      this.publish({ type: "entry_finished", entry });
    });
  }

  private appendText(entryId: string, text: string, truncated: boolean): void {
    this.enqueue(async () => {
      const event = { type: "harness.entry_appended" as const, at: new Date().toISOString(), harnessRunId: this.harnessRunId, entryId, text, truncated };
      await this.journal.append(event);
      this.applyProjection(event);
      this.publish({ type: "entry_appended", entryId, text, truncated });
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.#failure) return;
    const task = this.#queue.then(operation);
    this.#queue = task.catch((error: unknown) => { if (!this.#failure) this.#failure = error instanceof Error ? error : new Error(String(error)); });
  }

  private flushPending(which: "body" | "thought"): void {
    const pending = which === "body" ? this.#bodyPending : this.#thoughtPending;
    if (!pending) return;
    const entry = which === "body" ? this.#body : this.#thought;
    if (!entry) return;
    if (which === "body") this.#bodyPending = ""; else this.#thoughtPending = "";
    const budget = Math.max(0, (which === "body" ? BODY_MAX_BYTES : THOUGHT_MAX_BYTES) - (which === "body" ? this.#bodyBytes : this.#thoughtBytes));
    const { text, bytes, truncated } = takeUtf8(pending, budget);
    if (which === "body") this.#bodyBytes += bytes; else this.#thoughtBytes += bytes;
    if (which === "body" && this.#body) this.#body = { ...this.#body, text: this.#body.text + text, truncated: this.#body.truncated || truncated };
    if (which === "thought" && this.#thought) this.#thought = { ...this.#thought, text: this.#thought.text + text, truncated: this.#thought.truncated || truncated };
    if (!text) return;
    this.startEntry(entry);
    this.appendText(entry.entryId, text, truncated);
  }

  private finishOpenThought(status: "completed" | "interrupted"): void {
    if (!this.#thought) return;
    this.flushPending("thought");
    const entry = this.#thought;
    this.#thought = null;
    if (!entry || !this.#started.has(entry.entryId)) return;
    this.finishEntry({ ...entry, status, finishedAt: new Date().toISOString() });
  }

  /** 工具或思考插入时切断当前正文段：后续正文另建条目，回放顺序与真实流一致（不再把新文字并到首个正文段）。 */
  private finishOpenBody(completed: boolean): void {
    if (!this.#body) return;
    this.flushPending("body");
    const entry = this.#body;
    this.#body = null;
    if (!this.#started.has(entry.entryId)) return;
    this.finishEntry({ ...entry, completed, finishedAt: new Date().toISOString() });
  }

  private interruptLeftoverTools(): void {
    for (const [callId, entry] of this.#tools) {
      if (entry.status !== "running") continue;
      const finished: HarnessToolEntry = { ...entry, status: "interrupted", finishedAt: new Date().toISOString() };
      this.#tools.set(callId, finished);
      this.finishEntry(finished);
    }
  }

  private applyAcpFinish(callId: string, status: "completed" | "failed", contentText: string | null, rawOutput: unknown): void {
    const entry = this.#tools.get(callId);
    if (!entry || entry.status !== "running") return;
    // 终态快照整体替换输出；没有终态内容时保留已保存的过程输出，不被抹掉。
    const finalText = contentText ?? stringifyRaw(rawOutput);
    const prepared = finalText === null ? { text: entry.output, truncated: entry.outputTruncated } : this.prepareToolOutput(finalText);
    const finished: HarnessToolEntry = { ...entry, status, finishedAt: new Date().toISOString(), output: prepared.text, outputTruncated: prepared.truncated };
    this.#tools.set(callId, finished);
    this.finishEntry(finished);
  }

  /** ACP content 更新为整体替换语义：用最新快照覆盖输出（限长脱敏），并同步耐久一次替换后事实。 */
  private replaceToolOutput(callId: string, text: string): void {
    const entry = this.#tools.get(callId);
    if (!entry || entry.status !== "running") return;
    const remaining = TOOL_OUTPUT_TURN_MAX_BYTES - this.#toolOutputBytes + utf8Length(entry.output ?? "");
    const { text: clipped, bytes, truncated } = takeUtf8(redact(text), Math.max(0, Math.min(TOOL_OUTPUT_MAX_BYTES, remaining)));
    this.#toolOutputBytes += bytes - utf8Length(entry.output ?? "");
    const updated: HarnessToolEntry = { ...entry, output: clipped, outputTruncated: truncated };
    this.#tools.set(callId, updated);
    // 替换语义无法用追加事件表达：以一条“覆盖后全文”的追加事件回放会导致重复。
    // 因此 ACP 输出只在终态事件中耐久全文，过程替换不单独落盘。
  }

  private prepareToolOutput(raw: string | null): { readonly text: string | null; readonly truncated: boolean } {
    if (raw === null) return { text: null, truncated: false };
    const turnRemaining = TOOL_OUTPUT_TURN_MAX_BYTES - this.#toolOutputBytes;
    const budget = Math.max(0, Math.min(TOOL_OUTPUT_MAX_BYTES, turnRemaining));
    const { text, bytes, truncated } = takeUtf8(redact(raw), budget);
    this.#toolOutputBytes += bytes;
    return { text, truncated };
  }

  private scheduleFlush(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => { this.#flushTimer = null; this.flush(); }, COALESCE_MS);
    this.#flushTimer.unref?.();
  }
  private clearFlushTimer(): void { if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; } }
}

/** 允许字段提取/raw 值摘要：只保留短标量，深度截断，不保存完整请求、环境或快照。 */
function summarizeRaw(value: unknown, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  const text = stringifyRaw(value);
  return text === null ? null : clipChars(redact(text), maxChars);
}

function stringifyRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "string" && item.length > 500) return `${item.slice(0, 500)}…`;
      if (item && typeof item === "object") { if (seen.has(item)) return "[循环引用]"; seen.add(item); }
      return item;
    });
    return typeof text === "string" ? text : null;
  } catch { return null; }
}

/** 已知凭据形态的最小遮蔽；不宣称对任意输出的绝对脱敏保证。 */
function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, "$1…")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1…")
    .replace(/(AKIA)[A-Z0-9]{16}/g, "$1…")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)["'\s:=]+)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, "$1…");
}

/** 按 UTF-8 字节预算截取，绝不切断 surrogate pair 与多字节字符。 */
function takeUtf8(text: string, byteBudget: number): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  if (utf8Length(text) <= byteBudget) return { text, bytes: utf8Length(text), truncated: false };
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (bytes + size > byteBudget) break;
    bytes += size;
    end += char.length;
  }
  return { text: text.slice(0, end), bytes, truncated: true };
}

function utf8Length(text: string): number { return new TextEncoder().encode(text).byteLength; }
function clipChars(text: string | null, maxChars: number): string | null { if (text === null) return null; return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text; }
