import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadWorkflow } from "../workflow/load-workflow";
import { RunRuntime } from "../runtime/run-runtime";
import { isJsonObject } from "../shared/json";
import type { CreateRunRequest, ResumeRunRequest, RunResponse } from "./types";
import { createHash } from "node:crypto";
import { probeCapabilities } from "./capability-probe";
import { handleCompleteHttp } from "../control/control-http";
import { handleReclaimCompleteHttp } from "../control/control-http";
import { handleAnswerHttp, handleBlockHttp, handleContinueHttp, handleReclaimBlockHttp, handleReclaimContinueHttp } from "../control/block-http";
import type { ControlServer, ReclaimBlockSubmission, ReclaimCompletionSubmission, ReclaimContinueSubmission } from "../control/control-server";
import { createRealCodexExecutor } from "../runtime/real-codex-factory";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import type { AgentNodeExecutor } from "../runtime/run-types";
import { RealCodexExecutor } from "../runtime/real-codex-executor";
import { runsRoot, validateRunId } from "../journal/paths";
import { DAEMON_PROTOCOL_VERSION, daemonUserIdentity } from "./daemon-descriptor";
import { RunJournal } from "../journal/run-journal";
import { RUNTIME_VERSION } from "../journal/types";
import { AgentStartLimiter, LimitedAgentExecutor } from "./agent-start-limiter";
import { TmuxSessionBackend } from "../sessions/backends/tmux-session-backend";
import { TmuxCommandClient } from "../sessions/backends/tmux-command";
import { CodexAppServerAdapter, bunCodexAppServerConnection } from "../adapters/codex-app-server";

/** 真实 Codex 执行器的 daemon 内部工厂；仅用于生产构造与无模型服务的端到端测试注入。 */
export type RealCodexExecutorFactory = (args: {
  /** 当前 daemon 的 loopback Control 根地址。 */
  readonly controlUrl: string;
  /** 当前项目 Run 耐久目录的根路径。 */
  readonly runsRoot: string;
  /** 当前 daemon 的唯一私有 tmux socket 身份。 */
  readonly daemonInstanceId: string;
  /** 本次 Run 是否使用 App Server hybrid 投递。 */
  readonly codexRpcInput: boolean;
}) => RealCodexExecutor;

/** LocalDaemon 的可选构造配置；生产默认使用真实 Codex 执行器。 */
export type LocalDaemonOptions = {
  /** 仅自动测试使用确定性执行器；不能用于用户 CLI。默认 false。 */
  readonly deterministicForTest?: boolean;
  /** 替换真实执行器的创建方式，以便验证 daemon/Control 闭环而不连接模型服务。 */
  readonly createRealExecutor?: RealCodexExecutorFactory;
  /** 用户级 Run Store 根目录；仅测试或受控嵌入环境注入，生产默认 ~/.wave-flow/runs。 */
  readonly storeRoot?: string;
  /** 全局同时运行 Run 上限；生产默认保守值，测试可缩小。 */
  readonly maxActiveRuns?: number;
  /** 全局同时启动的真实 Agent 上限，同时限制 tmux 会话与 App Server 进程。 */
  readonly maxActiveAgents?: number;
  /** 验证旧 Journal 会话是否可被当前 daemon 安全认领；生产默认同时验证 tmux 与 App Server。 */
  readonly verifyReclaimSession?: (session: import("../sessions/types").SessionIdentity, appServer: { readonly endpoint: string; readonly threadId: string } | undefined) => Promise<boolean>;
};

/** 只监听 loopback 的最小 daemon；CLI 必须经它创建和查询 Run。 */
export class LocalDaemon {
  #runs = new Map<string, RunRuntime>();
  #controls = new Map<string, ControlServer>();
  #runTasks = new Map<string, Promise<unknown>>();
  #createRequests = new Map<string, Promise<RunResponse>>();
  /** 同一 Run 的并发 resume 只允许一个授权重放事务，防止重复新 attempt。 */
  #resumeRequests = new Map<string, Promise<RunResponse>>();
  #server: ReturnType<typeof Bun.serve> | null = null;
  readonly instanceId = crypto.randomUUID();
  bootInstanceId: string | null = null;

  private readonly deterministicForTest: boolean;
  private readonly createRealExecutor: RealCodexExecutorFactory;
  private readonly storeRoot: string;
  private readonly maxActiveRuns: number;
  private readonly agentStartLimiter: AgentStartLimiter;
  private readonly verifyReclaimSession: NonNullable<LocalDaemonOptions["verifyReclaimSession"]>;

  /**
   * @param options 自动测试可选择稳定或 fake 真实执行器；省略时启动真正 tmux/Codex。
   * 为保持已有测试调用兼容，也接受历史 boolean 形式；用户 CLI 不会传入该参数。
   */
  constructor(options: LocalDaemonOptions | boolean = {}) {
    const normalized = typeof options === "boolean" ? { deterministicForTest: options } : options;
    this.deterministicForTest = normalized.deterministicForTest === true;
    this.createRealExecutor = normalized.createRealExecutor ?? createRealCodexExecutor;
    this.storeRoot = normalized.storeRoot ?? runsRoot();
    this.maxActiveRuns = normalized.maxActiveRuns ?? 20;
    if (!Number.isInteger(this.maxActiveRuns) || this.maxActiveRuns < 1) throw new Error("maxActiveRuns 必须是不小于 1 的整数。");
    this.agentStartLimiter = new AgentStartLimiter(normalized.maxActiveAgents ?? 20);
    this.verifyReclaimSession = normalized.verifyReclaimSession ?? verifyReclaimSession;
  }

  /** 启动 HTTP 服务；默认随机端口，严格绑定 127.0.0.1。 */
  start(port = 0): { readonly baseUrl: string; stop(): void } {
    if (this.#server) throw new Error("Local daemon 已启动。");
    this.#server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => this.fetch(request) });
    return { baseUrl: `http://127.0.0.1:${this.#server.port}`, stop: () => this.stop() };
  }

  /** 供常驻 daemon 发布 descriptor 前注入稳定启动身份。 */
  setBootInstanceId(value: string): void { if (!value.trim() || this.bootInstanceId) throw new Error("daemon 启动身份无效或已设置。"); this.bootInstanceId = value; }

  /** 停止短生命周期 daemon；不会删除 Journal 或本地结果文件。 */
  stop(): void { this.#server?.stop(true); this.#server = null; }

  /** 注册一个真实 Run 的 ControlServer；必须与当前 daemon 中的同一 Run 绑定。 */
  registerControl(runId: string, control: ControlServer): void {
    const runtime = this.#runs.get(runId);
    if (!runtime || runtime.journal.manifest.runId !== runId) throw new Error("只能为当前 daemon 已知的 Run 注册 ControlServer。");
    if (this.#controls.has(runId)) throw new Error("该 Run 的 ControlServer 已注册。");
    this.#controls.set(runId, control);
  }

  private async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return this.json({ protocolVersion: DAEMON_PROTOCOL_VERSION, userIdentity: daemonUserIdentity(), bootInstanceId: this.bootInstanceId ?? this.instanceId });
      if (request.method === "GET" && url.pathname === "/capabilities") return this.json(await probeCapabilities());
      if (request.method === "POST" && url.pathname === "/runs") return this.json(await this.createRun(await this.readJson(request)));
      const resumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        const runId = decodeURIComponent(resumeMatch[1]);
        try { validateRunId(runId); } catch { throw new DaemonRequestError(400, "resume 路径中的 RunId 无效。 "); }
        return this.json(await this.resume(runId, await this.readJson(request)));
      }
      if (request.method === "GET" && /^\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        return this.json(await this.inspect(runId));
      }
      const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) return this.streamRunEvents(decodeURIComponent(eventsMatch[1]));
      const completeMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/complete$/);
      if (completeMatch) {
        const runId = decodeURIComponent(completeMatch[1]);
        const control = this.#controls.get(runId);
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleCompleteHttp(control, request);
      }
      const reclaimCompleteMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/reclaim-complete$/);
      if (reclaimCompleteMatch) {
        const runId = decodeURIComponent(reclaimCompleteMatch[1]);
        const body = await this.readJson(request) as ReclaimCompletionSubmission;
        if (body.runId !== runId) throw new DaemonRequestError(400, "reclaim complete 路径与请求 Run 不一致。");
        const control = await this.reclaimControl(body);
        return handleReclaimCompleteHttp(control, new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) }));
      }
      const blockMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/block$/);
      if (blockMatch) {
        const runId = decodeURIComponent(blockMatch[1]);
        const body = await this.readJson(request) as ReclaimBlockSubmission;
        if (body.runId !== runId) throw new DaemonRequestError(400, "reclaim block 路径与请求 Run 不一致。");
        const control = await this.reclaimControl(body);
        return handleReclaimBlockHttp(control, new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) }));
      }
      const answerMatch = url.pathname.match(/^\/blocks\/([^/]+)\/answer$/);
      if (answerMatch) {
        const blockRequestId = decodeURIComponent(answerMatch[1]);
        const control = [...this.#controls.values()].find((candidate) => candidate.hasBlock(blockRequestId)) ?? await this.restoreBlockedControl(blockRequestId);
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleAnswerHttp(control, blockRequestId, request);
      }
      const continueMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/continue$/);
      if (continueMatch) {
        const runId = decodeURIComponent(continueMatch[1]);
        const body = await this.readJson(request) as ReclaimContinueSubmission;
        if (body.runId !== runId) throw new DaemonRequestError(400, "reclaim continue 路径与请求 Run 不一致。");
        const control = await this.reclaimControl(body);
        return handleReclaimContinueHttp(control, new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) }));
      }
      throw new DaemonRequestError(404, "未知 daemon API 路径或方法。");
    } catch (error) {
      const status = error instanceof DaemonRequestError ? error.status : 400;
      const message = error instanceof Error ? error.message : String(error);
      return this.json({ error: message }, status);
    }
  }

  private async createRun(value: unknown): Promise<RunResponse> {
    if (!isCreateRunRequest(value)) throw new DaemonRequestError(400, "创建 Run 请求无效。");
    const inFlight = this.#createRequests.get(value.clientRequestId);
    if (inFlight) return inFlight;
    // 必须在任何 await 前登记：两个并发 POST 若都先完成磁盘查找，会各自创建一个 Run。
    const task = (async () => {
      // 第一条请求已经返回后，客户端仍可能因响应丢失而带着同一个
      // clientRequestId 重试。这时 Run 已在本 daemon 内存中运行，不能再从
      // Journal 以“无法恢复运行中 Run”为由拒绝它；直接返回同一份权威快照。
      const active = [...this.#runs.values()].find((runtime) => runtime.journal.manifest.clientRequestId === value.clientRequestId);
      if (active) return { runId: active.snapshot().id, snapshot: active.snapshot() };
      const durable = await this.findByClientRequestId(value.clientRequestId);
      if (!durable && [...this.#runs.values()].filter((runtime) => runtime.snapshot().status === "running").length >= this.maxActiveRuns) throw new DaemonRequestError(429, `全局运行中 Run 已达到上限：${this.maxActiveRuns}。`);
      return durable ?? this.createRunOnce(value);
    })().finally(() => this.#createRequests.delete(value.clientRequestId));
    this.#createRequests.set(value.clientRequestId, task);
    return task;
  }

  private async createRunOnce(value: CreateRunRequest): Promise<RunResponse> {
    const cwd = await realpath(value.cwd);
    const workflow = await loadWorkflow(value.workflowPath, cwd);
    const sourcePath = await realpath(resolve(cwd, value.workflowPath));
    const source = await Bun.file(sourcePath).text();
    const baseExecutor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: this.storeRoot, daemonInstanceId: this.instanceId, codexRpcInput: value.codexRpcInput !== false });
    const executor: AgentNodeExecutor = new LimitedAgentExecutor(baseExecutor, this.agentStartLimiter);
    const runtime = await RunRuntime.create({ workflow, input: value.input, workflowSource: source, clientRequestId: value.clientRequestId, workflowProjectCwd: cwd, workflowPath: sourcePath, storeRoot: this.storeRoot, executor });
    if (!this.deterministicForTest && baseExecutor instanceof RealCodexExecutor) {
      const control = runtime.createControlServer();
      baseExecutor.bindControl(control);
      this.#runs.set(runtime.snapshot().id, runtime);
      this.registerControl(runtime.snapshot().id, control);
    }
    const runId = runtime.snapshot().id;
    this.#runs.set(runId, runtime);
    const task = runtime.run(workflow).catch(() => undefined).finally(() => { this.#runTasks.delete(runId); });
    this.#runTasks.set(runId, task);
    await runtime.waitForSafeLaunch();
    return { runId: runtime.snapshot().id, snapshot: runtime.snapshot() };
  }

  /** 用户显式授权的调用级恢复；严格核验 Manifest 源码与项目边界后才重放。 */
  private async resume(runId: string, value: unknown): Promise<RunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as ResumeRunRequest).authorized !== true) throw new DaemonRequestError(400, "resume 必须明确携带 authorized: true。 ");
    const inFlight = this.#resumeRequests.get(runId);
    if (inFlight) return inFlight;
    // 必须在任一 await 前登记：两个 POST 若都先读取到没有 runTask，就会各自启动
    // 新 attempt，突破“一个 Run 同时只允许一条重放”的副作用边界。
    const task = this.resumeOnce(runId).finally(() => this.#resumeRequests.delete(runId));
    this.#resumeRequests.set(runId, task);
    return task;
  }

  private async resumeOnce(runId: string): Promise<RunResponse> {
    if (this.#runTasks.has(runId)) throw new DaemonRequestError(409, "该 Run 仍由当前 daemon 执行，不能重复 resume。 ");
    const opened = await RunJournal.open(runId, this.storeRoot);
    const manifest = opened.journal.manifest;
    if (manifest.runtimeVersion !== RUNTIME_VERSION) throw new DaemonRequestError(409, `resume 仅支持当前 Runtime v${RUNTIME_VERSION} 的 Run；历史 v${manifest.runtimeVersion} 只能读取。`);
    let source: string;
    try { source = await Bun.file(manifest.workflowPath).text(); } catch { throw new DaemonRequestError(409, "resume 的 Workflow 源码不可读取。 "); }
    if (createHash("sha256").update(source).digest("hex") !== manifest.workflowHash) throw new DaemonRequestError(409, "resume 拒绝：Workflow 源码 hash 已变化。 ");
    const cwd = await realpath(manifest.workflowProjectCwd).catch(() => { throw new DaemonRequestError(409, "resume 的 Workflow 项目目录不可验证。 "); });
    if (cwd !== manifest.workflowProjectCwd) throw new DaemonRequestError(409, "resume 拒绝：Workflow 项目目录已变化。 ");
    const workflow = await loadWorkflow(manifest.workflowPath, cwd);
    const baseExecutor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: this.storeRoot, daemonInstanceId: this.instanceId, codexRpcInput: true });
    const executor = new LimitedAgentExecutor(baseExecutor, this.agentStartLimiter);
    const runtime = await RunRuntime.resume(runId, executor, this.storeRoot);
    await this.reconcileResumeSessions(runtime, opened.events);
    if (!this.deterministicForTest && baseExecutor instanceof RealCodexExecutor) {
      const control = runtime.createControlServer();
      baseExecutor.bindControl(control);
      this.registerControlForResume(runId, control, runtime);
    }
    this.#runs.set(runId, runtime);
    const running = runtime.run(workflow);
    const task = running.catch(() => {
      // 不匹配的调用轨迹或新 attempt 启动失败不能留下内存 Control，避免用户修正
      // Workflow 后被“已注册”假状态永久拒绝下一次显式 resume。
      this.#runs.delete(runId);
      this.#controls.delete(runId);
    }).finally(() => this.#runTasks.delete(runId));
    this.#runTasks.set(runId, task);
    await Promise.race([runtime.waitForSafeLaunch(), running]);
    return { runId, snapshot: runtime.snapshot() };
  }

  /** resume 可能替换旧 daemon 的内存 Runtime，允许首次注册但拒绝重复 Control。 */
  private registerControlForResume(runId: string, control: ControlServer, runtime: RunRuntime): void {
    if (this.#controls.has(runId)) throw new DaemonRequestError(409, "该 Run 已有 ControlServer，不能重复 resume。 ");
    if (runtime.journal.manifest.runId !== runId) throw new DaemonRequestError(400, "resume Run 身份不一致。 ");
    this.#controls.set(runId, control);
  }

  /**
   * 用户已明确授权 resume 后，才检查旧 running / blocked 会话是否仍可验证。
   * 存活会话不重跑；不可验证会话先成为耐久 interrupted，再允许 Replay 创建新 attempt。
   */
  private async reconcileResumeSessions(runtime: RunRuntime, events: readonly import("../journal/types").JournalEvent[]): Promise<void> {
    const unverifiable: import("../runtime/run-types").AgentNodeSnapshot[] = [];
    for (const node of runtime.snapshot().phases.flatMap((phase) => phase.agents)) {
      if ((node.status !== "running" && node.status !== "blocked") || !node.agentSessionId) continue;
      const sessionEvent = sessionFor(events, node.id, node.agentSessionId);
      const verified = !!sessionEvent && await this.verifyReclaimSession(sessionEvent.session, sessionEvent.appServer ? { endpoint: sessionEvent.appServer.endpoint, threadId: sessionEvent.appServer.threadId } : undefined);
      if (verified) throw new DaemonRequestError(409, `resume 遇到仍可验证的旧会话：${node.id}；仅恢复 Control，不创建新 attempt。`);
      unverifiable.push(node);
    }
    // 所有旧会话均已确认不可验证后，才写 interrupted。避免一个并行节点仍存活时，
    // 已遍历到的其他节点被部分修改，随后 resume 又整体被拒绝。
    for (const node of unverifiable) {
      const event: import("../journal/types").JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: runtime.snapshot().id, nodeId: node.id, agentSessionId: node.agentSessionId, diagnostic: "用户显式 resume 时旧会话无法验证。", status: "interrupted" };
      await runtime.journal.append(event);
      runtime.state.apply(event);
    }
  }

  private async findByClientRequestId(clientRequestId: string): Promise<RunResponse | null> {
    let names: string[];
    try { names = await readdir(this.storeRoot); } catch { return null; }
    for (const runId of names) {
      try {
        const opened = await RunJournal.open(runId, this.storeRoot);
        if (opened.journal.manifest.clientRequestId !== clientRequestId) continue;
        const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
        if (runtime.snapshot().status === "running") throw new DaemonRequestError(409, "相同创建请求的 Run 仍在运行，但当前 daemon 未持有其权威状态；请启动或恢复 daemon。");
        this.#runs.set(runId, runtime);
        return { runId, snapshot: runtime.snapshot() };
      } catch (error) {
        if (error instanceof DaemonRequestError) throw error;
      }
    }
    return null;
  }

  private async inspect(runId: string): Promise<RunResponse> {
    const memory = this.#runs.get(runId);
    if (memory) return { runId, snapshot: memory.snapshot() };
    const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
    if (runtime.snapshot().status === "running") throw new DaemonRequestError(409, "Run 仍在运行，但当前 daemon 未持有其权威状态；请启动或恢复 daemon。");
    this.#runs.set(runId, runtime);
    return { runId, snapshot: runtime.snapshot() };
  }

  /**
   * 验证并重建旧受管 Agent 的 Control 节点；不创建 turn、不重发 Prompt。
   * 仅为本次 reclaim 控制操作恢复内存索引，Workflow 下游调度仍须用户 resume。
   */
  private async reclaimControl(request: Pick<ReclaimCompletionSubmission, "runId" | "nodeId" | "agentSessionId">): Promise<ControlServer> {
    let runtime = this.#runs.get(request.runId);
    if (!runtime) {
      runtime = await RunRuntime.open(request.runId, new DeterministicExecutor(), this.storeRoot);
      this.#runs.set(request.runId, runtime);
    }
    // 同一 daemon 内的节点已由短期 capability 注册；显式稳定身份仅用于定位，
    // 不应再次探测真实 tmux/App Server，避免短暂探测错误影响正常控制调用。
    // 影响正常运行中的 block / complete。并行 Run 的另一个未注册节点才继续恢复。
    const active = this.#controls.get(request.runId);
    if (active?.hasNode(request.runId, request.nodeId, request.agentSessionId)) return active;
    const opened = await RunJournal.open(request.runId, this.storeRoot);
    const sessionEvent = sessionFor(opened.events, request.nodeId, request.agentSessionId);
    if (!sessionEvent?.session.reclaimTokenHash) throw new DaemonRequestError(409, "该旧会话缺少受管 identity，不能跨 daemon 认领。");
    const snapshot = runtime.state.agent(request.nodeId);
    if ((snapshot.status !== "running" && snapshot.status !== "blocked") || snapshot.agentSessionId !== request.agentSessionId) throw new DaemonRequestError(409, "只能认领当前 running 或 blocked 的旧 Agent 会话。");
    if (!await this.verifyReclaimSession(sessionEvent.session, sessionEvent.appServer ? { endpoint: sessionEvent.appServer.endpoint, threadId: sessionEvent.appServer.threadId } : undefined)) throw new DaemonRequestError(409, "旧 tmux 或 App Server thread 无法验证，拒绝认领。");
    return this.restoreControl(runtime, opened, snapshot, sessionEvent);
  }

  /**
   * 用户答案抵达早于旧 Agent 重连时，从 Journal 恢复唯一 pending block。
   * 仍先验证旧 tmux / App Server；不会创建 Agent、turn 或新的 block 事实。
   */
  private async restoreBlockedControl(blockRequestId: string): Promise<ControlServer | null> {
    let names: string[];
    try { names = await readdir(this.storeRoot); } catch { return null; }
    for (const runId of names) {
      try {
        const opened = await RunJournal.open(runId, this.storeRoot);
        const runtime = this.#runs.get(runId) ?? await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
        const node = runtime.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.status === "blocked" && agent.block?.blockRequestId === blockRequestId);
        if (!node?.agentSessionId) continue;
        const sessionEvent = sessionFor(opened.events, node.id, node.agentSessionId);
        if (!sessionEvent?.session.reclaimTokenHash) continue;
        if (!await this.verifyReclaimSession(sessionEvent.session, sessionEvent.appServer ? { endpoint: sessionEvent.appServer.endpoint, threadId: sessionEvent.appServer.threadId } : undefined)) continue;
        this.#runs.set(runId, runtime);
        return this.restoreControl(runtime, opened, runtime.state.agent(node.id), sessionEvent);
      } catch { /* 某个无关或损坏 Run 不得阻止其他 pending block 的精确路由。 */ }
    }
    return null;
  }

  /** 已验证 Session 后重建单个 Control；只恢复内存索引和 pending block。 */
  private restoreControl(runtime: RunRuntime, opened: Awaited<ReturnType<typeof RunJournal.open>>, snapshot: import("../runtime/run-types").AgentNodeSnapshot, sessionEvent: Extract<import("../journal/types").JournalEvent, { type: "agent.session" }>): ControlServer {
    const existing = this.#controls.get(runtime.snapshot().id);
    if (existing?.hasNode(runtime.snapshot().id, snapshot.id, snapshot.agentSessionId!)) return existing;
    const block = snapshot.status === "blocked" ? recoveredBlock(opened.events, runtime.snapshot().id, snapshot.id, snapshot.agentSessionId!, snapshot.block?.blockRequestId) : undefined;
    if (snapshot.status === "blocked" && !block) throw new DaemonRequestError(409, "旧 blocked 节点缺少可恢复的 Journal block。");
    const control = existing ?? runtime.createControlServer();
    control.restore({ runId: runtime.snapshot().id, nodeId: snapshot.id, agentSessionId: snapshot.agentSessionId!, reclaimTokenHash: sessionEvent.session.reclaimTokenHash!, session: sessionEvent.session, ...(block ? { block } : {}) });
    if (!existing) this.#controls.set(runtime.snapshot().id, control);
    return control;
  }

  /**
   * 将 daemon 权威快照以 SSE 推送给 CLI 与未来 Web。
   *
   * 当前 Runtime 尚未提供事件订阅钩子，因此此处以短周期比较快照并只在变化时输出；
   * 客户端不读取终端文本，也不会凭 SSE 内容改变 Run 状态。
   */
  private async streamRunEvents(runId: string): Promise<Response> {
    const initial = await this.inspect(runId);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let previous = "";
        const publish = () => {
          const runtime = this.#runs.get(runId);
          if (!runtime) {
            if (timer) clearInterval(timer);
            controller.error(new Error("Run 不再由当前 daemon 管理。"));
            return;
          }
          const response: RunResponse = { runId, snapshot: runtime.snapshot() };
          const serialized = JSON.stringify(response);
          if (serialized === previous) return;
          previous = serialized;
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
          if (response.snapshot.status !== "running") {
            if (timer) clearInterval(timer);
            controller.close();
          }
        };
        publish();
        if (initial.snapshot.status === "running") timer = setInterval(publish, 200);
      },
      cancel: () => { if (timer) clearInterval(timer); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  private async readJson(request: Request): Promise<unknown> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DaemonRequestError(415, "请求必须使用 application/json。");
    try { return await request.json(); } catch { throw new DaemonRequestError(400, "请求 JSON 无效。"); }
  }

  private json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
}

/** 从已验证的 Journal 事实重建一个仍 pending 的 block，不写入任何新事件。 */
function recoveredBlock(events: readonly import("../journal/types").JournalEvent[], runId: string, nodeId: string, agentSessionId: string, blockRequestId: string | undefined): { readonly blockRequestId: string; readonly needHelp: string; readonly answerSchema?: import("../shared/workflow-types").JsonSchema; readonly answer: import("../shared/json").JsonObject | null } | null {
  if (!blockRequestId) return null;
  const created = events.find((event): event is Extract<import("../journal/types").JournalEvent, { type: "block.created" }> => event.type === "block.created" && event.runId === runId && event.nodeId === nodeId && event.agentSessionId === agentSessionId && event.blockRequestId === blockRequestId);
  if (!created) return null;
  const answered = events.find((event): event is Extract<import("../journal/types").JournalEvent, { type: "block.answered" }> => event.type === "block.answered" && event.runId === runId && event.nodeId === nodeId && event.agentSessionId === agentSessionId && event.blockRequestId === blockRequestId);
  return { blockRequestId, needHelp: created.needHelp, ...(created.answerSchema ? { answerSchema: created.answerSchema } : {}), answer: answered?.answer ?? null };
}

function sessionFor(events: readonly import("../journal/types").JournalEvent[], nodeId: string, agentSessionId: string): Extract<import("../journal/types").JournalEvent, { type: "agent.session" }> | undefined {
  return [...events].reverse().find((event): event is Extract<import("../journal/types").JournalEvent, { type: "agent.session" }> => event.type === "agent.session" && event.nodeId === nodeId && event.agentSessionId === agentSessionId);
}

/** 生产 reclaim 同时验证旧 tmux injected identity 与旧 App Server 的同一 thread；不创建 turn。 */
async function verifyReclaimSession(session: import("../sessions/types").SessionIdentity, appServer: { readonly endpoint: string; readonly threadId: string } | undefined): Promise<boolean> {
  const backend = new TmuxSessionBackend(new TmuxCommandClient(session.backendRef));
  if (await backend.liveness(session) !== "exists") return false;
  if (!appServer) return true;
  const adapter = new CodexAppServerAdapter(appServer.endpoint, bunCodexAppServerConnection);
  try { await adapter.verifyExistingThread(appServer.threadId, new AbortController().signal); return true; } catch { return false; } finally { await adapter.close().catch(() => {}); }
}

/**
 * 在 daemon 不在线时只读取已结束 Run 的耐久证据。
 * 运行中的 Run 没有内存状态机就无法可信重建，调用方应提示用户连接或恢复 daemon，
 * 绝不能据 Journal 猜测它是否仍在执行。
 */
export async function inspectStoredRun(runId: string, storeRoot = runsRoot()): Promise<RunResponse> {
  const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), storeRoot);
  if (runtime.snapshot().status === "running") throw new DaemonRequestError(409, "Run 仍在运行，但当前没有可验证的 daemon；请先启动或恢复 daemon。" );
  return { runId, snapshot: runtime.snapshot() };
}

class DaemonRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function isCreateRunRequest(value: unknown): value is CreateRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.clientRequestId === "string" && /^[0-9a-f-]{36}$/i.test(request.clientRequestId) && typeof request.workflowPath === "string" && typeof request.cwd === "string" && isJsonObject(request.input) && (request.codexRpcInput === undefined || typeof request.codexRpcInput === "boolean");
}
