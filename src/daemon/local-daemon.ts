import { readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadWorkflow } from "../workflow/load-workflow";
import { RunRuntime } from "../runtime/run-runtime";
import { isJsonObject } from "../shared/json";
import type { AcceptWorkflowRevisionRequest, AnswerDecisionRequest, CliRuntimeListResponse, CloseDaemonResponse, CreateExecutionRequest, CreateHarnessProjectRequest, CreateHarnessRunRequest, CreateRunRequest, CurrentAttemptResponse, DiscoverCliRuntimesResponse, ExecutionAttemptsResponse, ExecutionListResponse, ExecutionResponse, HarnessMessageRequest, HarnessMessagesResponse, HarnessProjectListResponse, HarnessProjectResponse, HarnessRunListResponse, HarnessRunResponse, PhaseVisitPageResponse, PhaseVisitResponse, ProposeWorkflowRevisionRequest, ResumeRunRequest, RunListItem, RunProgressEvent, RunResponse, SelectCliRuntimeResponse, StartHarnessConversationRequest, TerminalOpenResponse, ReclaimTerminalResponse, ValidateCliRuntimeRequest } from "./types";
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
import { AcpWorkerExecutor } from "../runtime/acp-worker-executor";
import { harnessRunsRoot, runsRoot, validateRunId } from "../journal/paths";
import { DAEMON_PROTOCOL_VERSION, daemonUserIdentity } from "./daemon-descriptor";
import { RunJournal } from "../journal/run-journal";
import { RUNTIME_VERSION } from "../journal/types";
import { AgentStartLimiter, LimitedAgentExecutor } from "./agent-start-limiter";
import { TmuxSessionBackend } from "../sessions/backends/tmux-session-backend";
import { TmuxCommandClient } from "../sessions/backends/tmux-command";
import { CodexAppServerAdapter, bunCodexAppServerConnection } from "../adapters/codex-app-server";
import { serveWebAsset } from "../web/static-assets";
import { TmuxTerminalObserver } from "../sessions/terminal-observer";
import type { ServerWebSocket } from "bun";
import { HarnessService } from "../harness/service";
import { HarnessProjectStore } from "../harness/projects";
import { HarnessExecutionService } from "../harness/executions";
import type { HarnessStreamEvent } from "../harness/types";
import { CliRuntimeRegistry } from "../runtimes/registry";
import { ShellPathDiscovery } from "../runtimes/shell-path-discovery";
import { validateCodexRuntime } from "../runtimes/codex-runtime-validator";
import { RuntimeAcpWorkerExecutor } from "../runtime/runtime-acp-worker-executor";
import { AcpHarnessSession } from "../harness/acp-harness";
import { resolveCodexAcpLauncher, runtimeProvenance } from "../runtimes/worker-launcher-resolver";
import { DeterministicHarnessSession } from "../harness/deterministic-session";

/** 真实 Codex 执行器的 daemon 内部工厂；仅用于生产构造与无模型服务的端到端测试注入。 */
/** 真实执行器必须在 Runtime 创建 Control 后显式绑定，避免无 capability 的受管 Agent。 */
export type ControlBoundExecutor = AgentNodeExecutor & { bindControl(control: ControlServer): void };

/** 用户本机 CLI 主控的固定系统约束；工具能力由 session-private MCP sidecar 提供。 */
const HARNESS_SYSTEM_PROMPT = "你是 Wave Flow 主控。你必须基于 session 中提供的 wave-flow-harness MCP 工具处理项目事实、提出 workflow 草案、读取执行结果或请求用户决定。你只能使用该 MCP 的只读查询和四个窄工具；禁止写入业务工作区、直接创建 Worker、直接执行 Workflow、调用 wave-flow complete/block/continue，或仅凭自然语言声称任务已完成。propose_workflow_revision 只产生草案，用户接受后才可能创建 Execution。";

export type RealCodexExecutorFactory = (args: {
  /** 当前 daemon 的 loopback Control 根地址。 */
  readonly controlUrl: string;
  /** 当前项目 Run 耐久目录的根路径。 */
  readonly runsRoot: string;
  /** 当前 daemon 的唯一私有 tmux socket 身份。 */
  readonly daemonInstanceId: string;
  /** 本次 Run 是否使用 App Server hybrid 投递。 */
  readonly codexRpcInput: boolean;
}) => ControlBoundExecutor;

/** LocalDaemon 的可选构造配置；生产默认使用真实 Codex 执行器。 */
export type LocalDaemonOptions = {
  /** 仅自动测试使用确定性执行器；不能用于用户 CLI。默认 false。 */
  readonly deterministicForTest?: boolean;
  /** 替换真实执行器的创建方式，以便验证 daemon/Control 闭环而不连接模型服务。 */
  readonly createRealExecutor?: RealCodexExecutorFactory;
  /** 用户级 Run Store 根目录；仅测试或受控嵌入环境注入，生产默认 ~/.wave-flow/runs。 */
  readonly storeRoot?: string;
  /** Harness 对话档案根目录；仅测试或受控嵌入环境注入，生产默认 ~/.wave-flow/harness-runs。 */
  readonly harnessRoot?: string;
  /** 全局同时运行 Run 上限；生产默认保守值，测试可缩小。 */
  readonly maxActiveRuns?: number;
  /** 全局同时启动的真实 Agent 上限，同时限制 tmux 会话与 App Server 进程。 */
  readonly maxActiveAgents?: number;
  /** 验证旧 Journal 会话是否可被当前 daemon 安全认领；生产默认同时验证 tmux 与 App Server。 */
  readonly verifyReclaimSession?: (session: import("../sessions/types").SessionIdentity, appServer: { readonly endpoint: string; readonly threadId: string } | undefined) => Promise<boolean>;
  /** 仅测试注入终端观察器；生产默认使用真实 tmux pipe-pane。 */
  readonly createTerminalObserver?: (session: import("../sessions/types").SessionIdentity) => TmuxTerminalObserver;
  /** 常驻 daemon 接收 close 后调用；测试 daemon 省略时只关闭本地 HTTP 服务。 */
  readonly scheduleClose?: () => void;
  /** 自动测试或显式兼容后端注入；生产省略时使用 selected ACP CLI Harness。 */
  readonly createHarnessSession?: (harnessRunId: string, cwd: string, prior: readonly import("../harness/types").HarnessMessage[], actions: import("../harness/action-tools").HarnessActionCallbacks) => Promise<import("../harness/session").HarnessSession>;
};

/** 只监听 loopback 的最小 daemon；CLI 必须经它创建和查询 Run。 */
export class LocalDaemon {
  #runs = new Map<string, RunRuntime>();
  #controls = new Map<string, ControlServer>();
  #runTasks = new Map<string, Promise<unknown>>();
  #harness: HarnessService;
  /** 侧边栏耐久项目；Harness 从项目继承 cwd。 */
  #projects: HarnessProjectStore;
  /** Harness 生成脚本的 WorkflowExecution 服务；Execution 不进入 Run 列表。 */
  #executions: HarnessExecutionService;
  /** 所有 ACP Worker 必须使用用户确认且启动前复核的本机 CLI Runtime。 */
  #cliRuntimes: CliRuntimeRegistry;
  /** 每条 Harness ACP session 私有 MCP token；只在 daemon 内存存活。 */
  #harnessMcpTokens = new Map<string, string>();
  /** 用户显式验证并认领的旧会话；资格精确绑定 node/session，不能放宽到整个 Run。 */
  #observedSessions = new Set<string>();
  /** 同一旧会话的并发认领单飞，防止两份 Runtime/Control 状态机互相覆盖。 */
  #terminalReclaims = new Map<string, Promise<ReclaimTerminalResponse>>();
  /** 同一 Run 的不同节点认领串行执行；不同 Run 仍可并行。 */
  #runReclaimLocks = new Map<string, Promise<void>>();
  #createRequests = new Map<string, Promise<RunResponse>>();
  /** 同一 Run 的并发 resume 只允许一个授权重放事务，防止重复新 attempt。 */
  #resumeRequests = new Map<string, Promise<RunResponse>>();
  /** 同一 Run 的用户控制必须串行；不同动作不能误复用彼此的成功结果。 */
  #runControlRequests = new Map<string, { readonly kind: "pause" | "recover" | "stop"; readonly promise: Promise<RunResponse> }>();
  /** 每个 Agent 只复用一条 pipe-pane，多个浏览器 WebSocket 共享输出而不重复订阅。 */
  #terminals = new Map<string, { readonly observer: TmuxTerminalObserver; readonly sockets: Set<ServerWebSocket<TerminalSocketData>>; readonly unsubscribe: () => void }>();
  /** 同一 Agent 的 observer 启动与关闭必须单飞，避免旧 close 误关刚重建的 pipe-pane。 */
  #terminalOpenings = new Map<string, Promise<{ readonly observer: TmuxTerminalObserver; readonly sockets: Set<ServerWebSocket<TerminalSocketData>>; readonly unsubscribe: () => void }>>();
  #terminalClosings = new Map<string, Promise<void>>();
  #terminalClosingKeys = new Set<string>();
  #server: ReturnType<typeof Bun.serve> | null = null;
  readonly instanceId = crypto.randomUUID();
  bootInstanceId: string | null = null;

  private readonly deterministicForTest: boolean;
  private readonly createRealExecutor: RealCodexExecutorFactory;
  private readonly hasCustomRealExecutor: boolean;
  private readonly storeRoot: string;
  private readonly maxActiveRuns: number;
  private readonly agentStartLimiter: AgentStartLimiter;
  private readonly verifyReclaimSession: NonNullable<LocalDaemonOptions["verifyReclaimSession"]>;
  private readonly createTerminalObserver: NonNullable<LocalDaemonOptions["createTerminalObserver"]>;
  private readonly scheduleClose: () => void;
  private readonly hasCustomHarnessSession: boolean;

  /**
   * @param options 自动测试可选择稳定或 fake 真实执行器；省略时启动真正 tmux/Codex。
   * 为保持已有测试调用兼容，也接受历史 boolean 形式；用户 CLI 不会传入该参数。
   */
  constructor(options: LocalDaemonOptions | boolean = {}) {
    const normalized = typeof options === "boolean" ? { deterministicForTest: options } : options;
    this.deterministicForTest = normalized.deterministicForTest === true;
    this.createRealExecutor = normalized.createRealExecutor ?? createRealCodexExecutor;
    this.hasCustomRealExecutor = normalized.createRealExecutor !== undefined;
    this.storeRoot = normalized.storeRoot ?? runsRoot();
    const harnessRoot = normalized.harnessRoot ?? harnessRunsRoot();
    this.#projects = new HarnessProjectStore(dirname(harnessRoot));
    this.#cliRuntimes = new CliRuntimeRegistry(dirname(harnessRoot));
    this.hasCustomHarnessSession = normalized.createHarnessSession !== undefined || this.deterministicForTest;
    const harnessFactory = normalized.createHarnessSession ?? (this.deterministicForTest
      ? async () => new DeterministicHarnessSession()
      : async (harnessRunId: string, cwd: string, prior: readonly import("../harness/types").HarnessMessage[], _actions: import("../harness/action-tools").HarnessActionCallbacks, frozenRuntime?: import("../runtimes/types").RuntimeProvenance) => {
      const runtime = frozenRuntime ? await this.#cliRuntimes.resolveByIdHarness(frozenRuntime.runtimeId) : await this.#cliRuntimes.resolveSelectedHarness("codex");
      const token = crypto.randomUUID(); this.#harnessMcpTokens.set(token, harnessRunId);
      const compiled = import.meta.dir.startsWith("/$bunfs/");
      const command = process.execPath;
      const args = compiled ? ["__harness-mcp"] : [join(import.meta.dir, "daemon-main.ts"), "__harness-mcp"];
      const mcpServer = { name: "wave-flow-harness", command, args, env: [
        { name: "WF_HARNESS_MCP_BASE_URL", value: `http://127.0.0.1:${this.#server!.port}` }, { name: "WF_HARNESS_MCP_TOKEN", value: token },
      ] } as any;
      const session = new AcpHarnessSession(resolveCodexAcpLauncher(runtime, this.currentControlCommand()), cwd, HARNESS_SYSTEM_PROMPT, prior, mcpServer);
      const close = session.close.bind(session); session.close = () => { this.#harnessMcpTokens.delete(token); close(); };
      return session;
    });
    this.#harness = new HarnessService(harnessRoot, harnessFactory, undefined, async () => {
      if (this.hasCustomHarnessSession) return { fingerprint: "injected-harness-session" };
      const runtime = await this.#cliRuntimes.resolveSelectedHarness("codex");
      return { fingerprint: createHash("sha256").update(`${runtime.runtimeId}\n${runtime.executablePath}\n${runtime.version}\n${runtime.verifiedAdapter.adapterId}\n${runtime.verifiedAdapter.adapterVersion}`).digest("hex"), runtime: runtimeProvenance(runtime) };
    });
    this.#executions = new HarnessExecutionService(this.#harness, () => this.createExecutionExecutor(), {
      wireControl: (runtime, wiring) => this.wireExecutionControl(runtime, wiring),
      // Execution 已写入终态后不再允许 Control 接口接收其旧 Worker 上报；释放
      // daemon 生命周期内映射，避免长时间使用后保留不可达的 ControlServer。
      onSettled: (executionId) => { this.#controls.delete(executionId); },
    }, harnessRoot);
    this.maxActiveRuns = normalized.maxActiveRuns ?? 20;
    if (!Number.isInteger(this.maxActiveRuns) || this.maxActiveRuns < 1) throw new Error("maxActiveRuns 必须是不小于 1 的整数。");
    this.agentStartLimiter = new AgentStartLimiter(normalized.maxActiveAgents ?? 20);
    this.verifyReclaimSession = normalized.verifyReclaimSession ?? verifyReclaimSession;
    this.createTerminalObserver = normalized.createTerminalObserver ?? ((session) => new TmuxTerminalObserver(session));
    this.scheduleClose = normalized.scheduleClose ?? (() => this.stop());
  }

  /** 启动 HTTP 服务；默认随机端口，严格绑定 127.0.0.1。 */
  start(port = 0): { readonly baseUrl: string; stop(): void } {
    if (this.#server) throw new Error("Local daemon 已启动。");
    this.#server = Bun.serve<TerminalSocketData>({ hostname: "127.0.0.1", port, fetch: (request, server) => this.fetch(request, server), websocket: {
      open: (socket) => this.openTerminalSocket(socket),
      message: (socket, message) => { void this.receiveTerminalInput(socket, typeof message === "string" ? message : new TextDecoder().decode(message)); },
      close: (socket) => this.closeTerminalSocket(socket),
    } });
    return { baseUrl: `http://127.0.0.1:${this.#server.port}`, stop: () => this.stop() };
  }

  /** 供常驻 daemon 发布 descriptor 前注入稳定启动身份。 */
  setBootInstanceId(value: string): void { if (!value.trim() || this.bootInstanceId) throw new Error("daemon 启动身份无效或已设置。"); this.bootInstanceId = value; }

  /** 停止短生命周期 daemon；不会删除 Journal 或本地结果文件。 */
  stop(): void {
    for (const key of [...this.#terminals.keys()]) void this.closeTerminal(key, "daemon-closed");
    this.#harness.close();
    this.#harnessMcpTokens.clear();
    this.#server?.stop(true); this.#server = null;
  }

  /** 新 daemon 启动后收敛上次在 pause/recover 中断的 Run；绝不创建新 turn。 */
  async reconcileRunControl(): Promise<void> {
    let runIds: string[];
    try { runIds = await readdir(this.storeRoot); } catch { return; }
    for (const runId of runIds) {
      try {
        const opened = await RunJournal.open(runId, this.storeRoot);
        const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
        const status = runtime.snapshot().status;
        if (status !== "pausing" && status !== "paused" && status !== "recovering") continue;
        // 旧 daemon 的 App Server 连接和 Workflow 调用栈均已丢失；即便 thread 还活着，
        // 新 daemon 也不能在没有原 agent() Promise 的情况下伪造 recover。不得重发
        // interrupt、clean 或 turn/start，耐久状态只能诚实收敛为 interrupted。
        const event: import("../journal/types").JournalEvent = { type: "run.status", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: `daemon 在 ${status} 中断；原 Workflow 调用栈不可恢复。`, status: "interrupted" };
        await opened.journal.append(event);
        runtime.state.apply(event);
        this.#runs.set(runId, runtime);
      } catch { /* 单个损坏或不可读 Run 不阻止 daemon 服务其余用户任务。 */ }
    }
  }

  /** 注册一个真实 Run 的 ControlServer；必须与当前 daemon 中的同一 Run 绑定。 */
  registerControl(runId: string, control: ControlServer): void {
    const runtime = this.#runs.get(runId);
    if (!runtime || runtime.journal.manifest.runId !== runId) throw new Error("只能为当前 daemon 已知的 Run 注册 ControlServer。");
    if (this.#controls.has(runId)) throw new Error("该 Run 的 ControlServer 已注册。");
    this.#controls.set(runId, control);
  }

  /** Execution 的底座执行器；Harness 执行只走 Codex ACP Worker 或测试确定性执行器。 */
  private createExecutionExecutor(): { readonly executor: AgentNodeExecutor; readonly wiring?: unknown } {
    if (this.deterministicForTest) return { executor: new LimitedAgentExecutor(new DeterministicExecutor(), this.agentStartLimiter) };
    const base: AgentNodeExecutor = this.hasCustomRealExecutor
      ? this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: this.storeRoot, daemonInstanceId: this.instanceId, codexRpcInput: true })
      : new RuntimeAcpWorkerExecutor(this.#cliRuntimes, () => this.currentControlCommand());
    return { executor: new LimitedAgentExecutor(base, this.agentStartLimiter), wiring: base };
  }

  /**
   * Execution 复用与 Run 完全相同的 Control 边界：ControlServer 以 Execution 的内嵌
   * runId 注册，Worker 的 complete/block/continue 走既有 HTTP 路由，不知道自己在 Execution 中。
   */
  private wireExecutionControl(runtime: RunRuntime, wiring: unknown): void {
    if (this.deterministicForTest || !wiring || !isControlBoundExecutor(wiring as AgentNodeExecutor)) return;
    const control = runtime.createControlServer();
    (wiring as ControlBoundExecutor).bindControl(control);
    const runId = runtime.journal.manifest.runId;
    if (this.#controls.has(runId)) throw new Error("该 Execution 的 ControlServer 已注册。 ");
    this.#controls.set(runId, control);
  }

  private async fetch(request: Request, server?: ReturnType<typeof Bun.serve<TerminalSocketData>>): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return this.json({ protocolVersion: DAEMON_PROTOCOL_VERSION, userIdentity: daemonUserIdentity(), bootInstanceId: this.bootInstanceId ?? this.instanceId });
      const harnessMcp = url.pathname.match(/^\/harness-mcp\/([^/]+)$/);
      if (request.method === "POST" && harnessMcp) return this.json(await this.harnessMcp(decodeURIComponent(harnessMcp[1]), await this.readJson(request)));
      if (request.method === "GET" && url.pathname === "/capabilities") return this.json(await probeCapabilities());
      if (request.method === "POST" && url.pathname === "/daemon/close") return this.closeDaemon(await this.readJson(request));
      if (request.method === "GET" && url.pathname === "/api/runs") return this.json(await this.listRuns());
      if (request.method === "GET" && url.pathname === "/cli-runtimes") return this.json(await this.listCliRuntimes());
      if (request.method === "POST" && url.pathname === "/cli-runtimes/discover") return this.json(await this.discoverCliRuntimes(await this.readJson(request)));
      if (request.method === "POST" && url.pathname === "/cli-runtimes/validate") return this.json(await this.validateCliRuntime(await this.readJson(request)));
      const cliRuntimeSelect = url.pathname.match(/^\/cli-runtimes\/([^/]+)\/select$/);
      if (request.method === "POST" && cliRuntimeSelect) return this.json(await this.selectCliRuntime(decodeURIComponent(cliRuntimeSelect[1]), await this.readJson(request)));
      const cliRuntimeDelete = url.pathname.match(/^\/cli-runtimes\/([^/]+)$/);
      if (request.method === "DELETE" && cliRuntimeDelete) return this.json(await this.deleteCliRuntime(decodeURIComponent(cliRuntimeDelete[1])));
      if (request.method === "GET" && url.pathname === "/api/harness-runs") return this.json(await this.listHarnesses());
      if (request.method === "GET" && url.pathname === "/projects") return this.json(await this.listProjects());
      if (request.method === "POST" && url.pathname === "/projects") return this.json(await this.createProject(await this.readJson(request)));
      const projectFirstMessageMatch = url.pathname.match(/^\/projects\/([^/]+)\/harness-messages$/);
      if (request.method === "POST" && projectFirstMessageMatch) return this.json(await this.startHarnessConversation(decodeURIComponent(projectFirstMessageMatch[1]), await this.readJson(request)));
      if (request.method === "POST" && url.pathname === "/harness-runs") return this.json(await this.createHarness(await this.readJson(request)));
      const harnessMatch = url.pathname.match(/^\/harness-runs\/([^/]+)$/);
      if (request.method === "GET" && harnessMatch) return this.json(await this.harnessSnapshot(decodeURIComponent(harnessMatch[1])));
      const harnessMessagesMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/messages$/);
      if (harnessMessagesMatch) {
        const harnessRunId = decodeURIComponent(harnessMessagesMatch[1]);
        if (request.method === "GET") return this.json(await this.harnessMessages(harnessRunId));
        if (request.method === "POST") return this.json(await this.sendHarnessMessage(harnessRunId, await this.readJson(request)));
      }
      const harnessAbortMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/abort$/);
      if (request.method === "POST" && harnessAbortMatch) return this.json(await this.abortHarness(decodeURIComponent(harnessAbortMatch[1]), await this.readJson(request)));
      const workflowRevisionMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/workflow-revisions$/);
      if (request.method === "POST" && workflowRevisionMatch) return this.json(await this.proposeWorkflowRevision(decodeURIComponent(workflowRevisionMatch[1]), await this.readJson(request)));
      const workflowAcceptMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/workflow-revisions\/(\d+)\/accept$/);
      if (request.method === "POST" && workflowAcceptMatch) return this.json(await this.acceptWorkflowRevision(decodeURIComponent(workflowAcceptMatch[1]), Number(workflowAcceptMatch[2]), await this.readJson(request)));
      const executionsMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/executions$/);
      if (executionsMatch) {
        const harnessRunId = decodeURIComponent(executionsMatch[1]);
        if (request.method === "POST") return this.json(await this.createExecution(harnessRunId, await this.readJson(request)));
        if (request.method === "GET") return this.json(await this.listExecutions(harnessRunId));
      }
      const executionGateMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/executions\/([^/]+)\/gates\/([^/]+)\/answer$/);
      if (request.method === "POST" && executionGateMatch) return this.json(await this.answerExecutionGate(decodeURIComponent(executionGateMatch[1]), decodeURIComponent(executionGateMatch[2]), decodeURIComponent(executionGateMatch[3]), await this.readJson(request)));
      const executionResumeMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/executions\/([^/]+)\/resume$/);
      if (request.method === "POST" && executionResumeMatch) return this.json(await this.resumeExecution(decodeURIComponent(executionResumeMatch[1]), decodeURIComponent(executionResumeMatch[2]), await this.readJson(request)));
      const executionControlMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/executions\/([^/]+)\/(pause|recover|stop)$/);
      if (request.method === "POST" && executionControlMatch) return this.json(await this.controlExecution(decodeURIComponent(executionControlMatch[1]), decodeURIComponent(executionControlMatch[2]), executionControlMatch[3] as "pause" | "recover" | "stop", await this.readJson(request)));
      const executionEventsMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/executions\/([^/]+)\/events$/);
      if (request.method === "GET" && executionEventsMatch) return this.streamExecutionEvents(decodeURIComponent(executionEventsMatch[1]), decodeURIComponent(executionEventsMatch[2]));
      const executionSnapshotMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/executions\/([^/]+)$/);
      if (request.method === "GET" && executionSnapshotMatch) return this.json(await this.executionSnapshot(decodeURIComponent(executionSnapshotMatch[1]), decodeURIComponent(executionSnapshotMatch[2])));
      const harnessDecisionMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/decisions\/([^/]+)\/answer$/);
      if (request.method === "POST" && harnessDecisionMatch) return this.json(await this.answerHarnessDecision(decodeURIComponent(harnessDecisionMatch[1]), decodeURIComponent(harnessDecisionMatch[2]), await this.readJson(request)));
      const harnessEventsMatch = url.pathname.match(/^\/harness-runs\/([^/]+)\/events$/);
      if (request.method === "GET" && harnessEventsMatch) return this.harnessEvents(decodeURIComponent(harnessEventsMatch[1]));
      const terminalMatch = url.pathname.match(/^\/runs\/([^/]+)\/nodes\/([^/]+)\/terminal$/);
      if (request.method === "GET" && terminalMatch) return this.json(await this.openTerminal(decodeURIComponent(terminalMatch[1]), decodeURIComponent(terminalMatch[2])));
      const reclaimTerminalMatch = url.pathname.match(/^\/runs\/([^/]+)\/nodes\/([^/]+)\/terminal\/reclaim$/);
      if (request.method === "POST" && reclaimTerminalMatch) return this.json(await this.reclaimTerminal(decodeURIComponent(reclaimTerminalMatch[1]), decodeURIComponent(reclaimTerminalMatch[2]), await this.readJson(request)));
      const terminalStreamMatch = url.pathname.match(/^\/runs\/([^/]+)\/nodes\/([^/]+)\/terminal\/stream$/);
      if (request.method === "GET" && terminalStreamMatch) {
        const runId = decodeURIComponent(terminalStreamMatch[1]); const nodeId = decodeURIComponent(terminalStreamMatch[2]);
        const terminal = await this.requireTerminal(runId, nodeId);
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0) throw new DaemonRequestError(400, "终端输出序号无效。 ");
        if (!server?.upgrade(request, { data: { key: terminal.key, runId, nodeId, after } })) return new Response("WebSocket upgrade failed", { status: 400 });
        return undefined as never;
      }
      if (request.method === "POST" && url.pathname === "/runs") return this.json(await this.createRun(await this.readJson(request)));
      const resumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        const runId = decodeURIComponent(resumeMatch[1]);
        try { validateRunId(runId); } catch { throw new DaemonRequestError(400, "resume 路径中的 RunId 无效。 "); }
        return this.json(await this.resume(runId, await this.readJson(request)));
      }
      const pauseMatch = url.pathname.match(/^\/runs\/([^/]+)\/pause$/);
      if (request.method === "POST" && pauseMatch) return this.json(await this.pause(decodeURIComponent(pauseMatch[1]), await this.readJson(request)));
      const recoverMatch = url.pathname.match(/^\/runs\/([^/]+)\/recover$/);
      if (request.method === "POST" && recoverMatch) return this.json(await this.recover(decodeURIComponent(recoverMatch[1]), await this.readJson(request)));
      const stopMatch = url.pathname.match(/^\/runs\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) return this.json(await this.stopRun(decodeURIComponent(stopMatch[1]), await this.readJson(request)));
      if (request.method === "GET" && /^\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        return this.json(await this.inspect(runId));
      }
      const currentAttemptMatch = url.pathname.match(/^\/runs\/([^/]+)\/attempts\/current$/);
      if (request.method === "GET" && currentAttemptMatch) return this.json(await this.currentAttempt(decodeURIComponent(currentAttemptMatch[1])));
      const attemptsMatch = url.pathname.match(/^\/runs\/([^/]+)\/attempts$/);
      if (request.method === "GET" && attemptsMatch) return this.json(await this.executionAttempts(decodeURIComponent(attemptsMatch[1])));
      const phaseVisitMatch = url.pathname.match(/^\/runs\/([^/]+)\/phase-visits\/(\d+)$/);
      if (request.method === "GET" && phaseVisitMatch) return this.json(await this.phaseVisit(decodeURIComponent(phaseVisitMatch[1]), Number(phaseVisitMatch[2]), parseAttempt(url)));
      const phaseVisitsMatch = url.pathname.match(/^\/runs\/([^/]+)\/phase-visits$/);
      if (request.method === "GET" && phaseVisitsMatch) return this.json(await this.phaseVisits(decodeURIComponent(phaseVisitsMatch[1]), url));
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
      const activeBlockMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/block-active$/);
      if (activeBlockMatch) {
        const runId = decodeURIComponent(activeBlockMatch[1]);
        const control = this.#controls.get(runId);
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleBlockHttp(control, request);
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
      const activeContinueMatch = url.pathname.match(/^\/runs\/([^/]+)\/control\/continue-active$/);
      if (activeContinueMatch) {
        const runId = decodeURIComponent(activeContinueMatch[1]);
        const control = this.#controls.get(runId);
        if (!control) throw new DaemonRequestError(404, "该 Run 未注册 ControlServer。");
        return handleContinueHttp(control, request);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const asset = serveWebAsset(url.pathname);
        if (asset) return request.method === "HEAD" ? new Response(null, { status: asset.status, headers: asset.headers }) : asset;
      }
      throw new DaemonRequestError(404, "未知 daemon API 路径或方法。");
    } catch (error) {
      const status = error instanceof DaemonRequestError ? error.status : 400;
      const message = error instanceof Error ? error.message : String(error);
      return this.json({ error: message }, status);
    }
  }

  /** 创建独立 Harness 对话，不创建 Workflow Run、Worker 或 Control。 */
  private async createHarness(value: unknown): Promise<HarnessRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as CreateHarnessRunRequest).projectId !== "string") throw new DaemonRequestError(400, "创建 Harness 请求无效。 ");
    try {
      const project = await this.#projects.get((value as CreateHarnessRunRequest).projectId);
      if (!this.hasCustomHarnessSession) await this.#cliRuntimes.resolveSelectedHarness("codex");
      const harness = await this.#harness.create(project.cwd, project.projectId);
      await this.#projects.touch(project.projectId);
      return { harness };
    } catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }
  /** 首条消息是新 Harness 的持久化边界；UI 草稿从不通过此路径前写入 daemon。 */
  private async startHarnessConversation(projectId: string, value: unknown): Promise<HarnessRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as StartHarnessConversationRequest).projectId !== "string" || (value as StartHarnessConversationRequest).projectId !== projectId || typeof (value as StartHarnessConversationRequest).text !== "string") throw new DaemonRequestError(400, "新会话首条消息请求无效。 ");
    try {
      const project = await this.#projects.get(projectId);
      // 首发前验证 Runtime，避免先创建不可运行的 Harness manifest/Journaling。
      if (!this.hasCustomHarnessSession) await this.#cliRuntimes.resolveSelectedHarness("codex");
      const harness = await this.#harness.start(project.cwd, project.projectId, (value as StartHarnessConversationRequest).text);
      await this.#projects.touch(project.projectId);
      return { harness };
    } catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }
  private async listProjects(): Promise<HarnessProjectListResponse> { return { projects: await this.#projects.list() }; }
  /** Control 命令只由当前 daemon 计算，绝不从用户 Runtime 或 PATH 获得。 */
  private currentControlCommand(): string {
    const compiled = import.meta.dir.startsWith("/$bunfs/");
    return compiled ? shellQuote(join(dirname(process.execPath), "wave-flow")) : `${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "../cli/main.ts"))}`;
  }

  private async createProject(value: unknown): Promise<HarnessProjectResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as CreateHarnessProjectRequest).cwd !== "string" || ((value as CreateHarnessProjectRequest).title !== undefined && typeof (value as CreateHarnessProjectRequest).title !== "string")) throw new DaemonRequestError(400, "创建项目请求无效。 ");
    try { return { project: await this.#projects.create((value as CreateHarnessProjectRequest).cwd, (value as CreateHarnessProjectRequest).title) }; }
    catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 返回设置页可展示的 Runtime；不暴露文件身份、PATH 或任何环境变量。 */
  private async listCliRuntimes(): Promise<CliRuntimeListResponse> { return this.#cliRuntimes.list(); }

  /** discovery 只能由用户按钮明确触发；请求体必须为空，禁止携带 shell 文本。 */
  private async discoverCliRuntimes(value: unknown): Promise<DiscoverCliRuntimesResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "扫描本机 CLI 不接受请求字段。 ");
    try { return { candidates: await new ShellPathDiscovery().discover() }; }
    catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 验证固定 adapter 与用户明确给出的绝对 CLI 路径；成功也不自动选为默认。 */
  private async validateCliRuntime(value: unknown): Promise<SelectCliRuntimeResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as ValidateCliRuntimeRequest).executablePath !== "string") throw new DaemonRequestError(400, "CLI Runtime 验证请求无效。 ");
    const request = value as ValidateCliRuntimeRequest;
    const discoveredFrom = request.discoveredFrom ?? "manual";
    if (!["shell-path", "gui-path", "manual"].includes(discoveredFrom) || (request.discoveredShell !== undefined && request.discoveredShell !== null && typeof request.discoveredShell !== "string")) throw new DaemonRequestError(400, "CLI Runtime 验证来源无效。 ");
    try {
      const verified = await validateCodexRuntime({ executablePath: request.executablePath, discoveredFrom, discoveredShell: request.discoveredShell ?? null, controlCommand: this.currentControlCommand() });
      const stored = await this.#cliRuntimes.saveVerified(verified); const { executableIdentity: _identity, ...runtime } = stored;
      return { runtime };
    } catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 用户显式选择后才允许真实 Worker 使用该 CLI。 */
  private async selectCliRuntime(runtimeId: string, value: unknown): Promise<SelectCliRuntimeResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "选择 CLI Runtime 不接受请求字段。 ");
    try { return { runtime: await this.#cliRuntimes.select(runtimeId) }; }
    catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }

  private async deleteCliRuntime(runtimeId: string): Promise<{ readonly deleted: true }> {
    try { await this.#cliRuntimes.remove(runtimeId); return { deleted: true }; }
    catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }

  private async harnessSnapshot(harnessRunId: string): Promise<HarnessRunResponse> { return { harness: await this.#harness.snapshot(harnessRunId) }; }
  private async listHarnesses(): Promise<HarnessRunListResponse> { return { harnesses: await this.#harness.list() }; }
  /** 私有 MCP sidecar 只以 token 定位当前 Harness；token 不存在、过期或跨会话一律拒绝。 */
  private async harnessMcp(token: string, value: unknown): Promise<unknown> {
    const harnessRunId = this.#harnessMcpTokens.get(token);
    if (!harnessRunId) throw new DaemonRequestError(404, "Harness MCP 会话不存在或已过期。 ");
    if (!value || typeof value !== "object" || Array.isArray(value) || !["list", "call"].includes((value as { operation?: unknown }).operation as string) || !(value as { value?: unknown }).value || typeof (value as { value: unknown }).value !== "object" || Array.isArray((value as { value: unknown }).value)) throw new DaemonRequestError(400, "Harness MCP 请求无效。 ");
    try { return await this.#harness.mcpTools(harnessRunId, value as { operation: "list" | "call"; value: Record<string, unknown> }); }
    catch (error) { throw new DaemonRequestError(400, error instanceof Error ? error.message : String(error)); }
  }
  private async harnessMessages(harnessRunId: string): Promise<HarnessMessagesResponse> { const harness = await this.#harness.snapshot(harnessRunId); return { harnessRunId, status: harness.status, messages: harness.messages }; }
  private async sendHarnessMessage(harnessRunId: string, value: unknown): Promise<HarnessRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as HarnessMessageRequest).text !== "string") throw new DaemonRequestError(400, "Harness 消息请求无效。 ");
    await this.#harness.send(harnessRunId, (value as HarnessMessageRequest).text);
    return { harness: await this.#harness.snapshot(harnessRunId) };
  }
  private async abortHarness(harnessRunId: string, value: unknown): Promise<HarnessRunResponse> { if (!isEmptyObject(value)) throw new DaemonRequestError(400, "Harness abort 不接受请求字段。 "); await this.#harness.abort(harnessRunId); return { harness: await this.#harness.snapshot(harnessRunId) }; }
  private async proposeWorkflowRevision(harnessRunId: string, value: unknown): Promise<HarnessRunResponse> { if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as ProposeWorkflowRevisionRequest).source !== "string") throw new DaemonRequestError(400, "Workflow 草案请求无效。 "); return { harness: await this.#harness.proposeWorkflowRevision(harnessRunId, (value as ProposeWorkflowRevisionRequest).source) }; }
  private async acceptWorkflowRevision(harnessRunId: string, revision: number, value: unknown): Promise<HarnessRunResponse> { if (!isEmptyObject(value)) throw new DaemonRequestError(400, "接受 Workflow 草案不接受请求字段。 "); return { harness: await this.#harness.acceptWorkflowRevision(harnessRunId, revision) }; }

  /** 创建并后台启动 Execution；编译失败在任何耐久事实之前拒绝。 */
  private async createExecution(harnessRunId: string, value: unknown): Promise<ExecutionResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DaemonRequestError(400, "创建 Execution 请求无效。 ");
    const { revision, input } = value as CreateExecutionRequest;
    if (!Number.isInteger(revision) || revision < 1) throw new DaemonRequestError(400, "创建 Execution 必须提供有效 revision 序号。 ");
    if (input !== undefined && !isJsonObject(input)) throw new DaemonRequestError(400, "Execution input 必须是 JSON-safe 对象。 ");
    try {
      if (!this.deterministicForTest && !this.hasCustomRealExecutor) await this.#cliRuntimes.resolveSelected("codex");
      return await this.#executions.createExecution(harnessRunId, revision, input ?? {});
    } catch (error) { throw this.executionError(error); }
  }

  private async listExecutions(harnessRunId: string): Promise<ExecutionListResponse> {
    return { harnessRunId, executions: await this.#executions.listExecutions(harnessRunId) };
  }

  /** Execution 详情：登记事实 + 内嵌 Run 权威快照（含决策门）。 */
  private async executionSnapshot(harnessRunId: string, executionId: string): Promise<ExecutionResponse> {
    const execution = (await this.#executions.listExecutions(harnessRunId)).find((item) => item.executionId === executionId);
    if (!execution) throw new DaemonRequestError(404, "未知 WorkflowExecution。 ");
    try {
      return { execution, snapshot: await this.#executions.snapshotExecution(harnessRunId, executionId) };
    } catch (error) { throw this.executionError(error); }
  }

  private async controlExecution(harnessRunId: string, executionId: string, kind: "pause" | "recover" | "stop", value: unknown): Promise<ExecutionResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, `Execution ${kind} 不接受请求字段。 `);
    try {
      const snapshot = kind === "pause" ? await this.#executions.pause(harnessRunId, executionId) : kind === "recover" ? await this.#executions.recover(harnessRunId, executionId) : await this.#executions.stop(harnessRunId, executionId);
      const execution = (await this.#executions.listExecutions(harnessRunId)).find((item) => item.executionId === executionId);
      if (!execution) throw new DaemonRequestError(404, "未知 WorkflowExecution。 ");
      return { execution, snapshot };
    } catch (error) { throw this.executionError(error); }
  }

  /** 用户显式恢复中断的 Execution；同一冻结 revision 产生新的 executionAttempt。 */
  private async resumeExecution(harnessRunId: string, executionId: string, value: unknown): Promise<ExecutionResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { authorized?: unknown }).authorized !== true) throw new DaemonRequestError(400, "resume 必须明确携带 authorized: true。 ");
    try {
      const snapshot = await this.#executions.resume(harnessRunId, executionId);
      const execution = (await this.#executions.listExecutions(harnessRunId)).find((item) => item.executionId === executionId);
      if (!execution) throw new DaemonRequestError(404, "未知 WorkflowExecution。 ");
      return { execution, snapshot };
    } catch (error) { throw this.executionError(error); }
  }

  /** 用户对脚本决策门提交答案；Schema 校验通过并耐久后只唤醒等待中的脚本。 */
  private async answerExecutionGate(harnessRunId: string, executionId: string, gateId: string, value: unknown): Promise<ExecutionResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonObject((value as AnswerDecisionRequest).answer)) throw new DaemonRequestError(400, "决策门答案必须是 JSON 对象。 ");
    try {
      const snapshot = await this.#executions.answerGate(harnessRunId, executionId, gateId, (value as AnswerDecisionRequest).answer);
      const execution = (await this.#executions.listExecutions(harnessRunId)).find((item) => item.executionId === executionId);
      if (!execution) throw new DaemonRequestError(404, "未知 WorkflowExecution。 ");
      return { execution, snapshot };
    } catch (error) { throw this.executionError(error); }
  }

  /** 用户回答主控 request_user_decision；答案只唤醒原工具调用。 */
  private async answerHarnessDecision(harnessRunId: string, decisionId: string, value: unknown): Promise<HarnessRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonObject((value as AnswerDecisionRequest).answer)) throw new DaemonRequestError(400, "决策答案必须是 JSON 对象。 ");
    try {
      return { harness: await this.#harness.answerUserDecision(harnessRunId, decisionId, (value as AnswerDecisionRequest).answer) };
    } catch (error) { throw this.executionError(error); }
  }

  /** Execution SSE：轮询内嵌 Run 快照，终态后关闭；不含终端字节。 */
  private async streamExecutionEvents(harnessRunId: string, executionId: string): Promise<Response> {
    const initial = await this.executionSnapshot(harnessRunId, executionId);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let previous = "";
        const publish = async () => {
          try {
            const snapshot = await this.#executions.snapshotExecution(harnessRunId, executionId);
            const serialized = JSON.stringify(snapshot);
            if (serialized === previous) return;
            previous = serialized;
            controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
            if (snapshot.status !== "running" && snapshot.status !== "pausing" && snapshot.status !== "recovering") {
              if (timer) clearInterval(timer);
              controller.close();
            }
          } catch { /* 暂不可读时等待下一轮轮询；终态判定只认成功读取的快照。 */ }
        };
        void publish();
        if (initial.snapshot.status === "running" || initial.snapshot.status === "pausing" || initial.snapshot.status === "recovering") timer = setInterval(() => void publish(), 200);
      },
      cancel: () => { if (timer) clearInterval(timer); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  /** Execution 服务错误到 HTTP 状态的映射；控制冲突为 409，未知身份为 404。 */
  private executionError(error: unknown): DaemonRequestError {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DaemonRequestError) return error;
    if (message.includes("未结束") || message.includes("可控制生命周期") || message.includes("不能同时执行") || message.includes("已在当前 daemon 运行") || message.includes("已回答") || message.includes("可以 pause") || message.includes("可以 recover")) return new DaemonRequestError(409, message);
    if (message.includes("未知")) return new DaemonRequestError(404, message);
    return new DaemonRequestError(400, message);
  }
  /** SSE 只传递当前回合的 reasoning/text delta；订阅断开绝不取消 Pi turn。 */
  private async harnessEvents(harnessRunId: string): Promise<Response> {
    await this.#harness.snapshot(harnessRunId);
    const harness = this.#harness;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: HarnessStreamEvent) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        unsubscribe = await harness.subscribe(harnessRunId, send);
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(await harness.snapshot(harnessRunId))}\n\n`));
      },
      cancel() { unsubscribe?.(); },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }

  /** 先发送确认响应，再由常驻 daemon 自己清理 descriptor、lock 与 HTTP 服务。 */
  private closeDaemon(value: unknown): Response {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "daemon close 不接受请求字段。 ");
    queueMicrotask(() => this.scheduleClose());
    return this.json({ closing: true } satisfies CloseDaemonResponse);
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
      if (!durable && [...this.#runs.values()].filter((runtime) => isLiveRunStatus(runtime.snapshot().status)).length >= this.maxActiveRuns) throw new DaemonRequestError(429, `全局运行中 Run 已达到上限：${this.maxActiveRuns}。`);
      return durable ?? this.createRunOnce(value);
    })().finally(() => this.#createRequests.delete(value.clientRequestId));
    this.#createRequests.set(value.clientRequestId, task);
    return task;
  }

  /** Local Web 总览：当前 daemon 内存中的 Run 为权威；不扫描或接管其他 daemon 的活跃任务。 */
  private async listRuns(): Promise<readonly RunListItem[]> {
    const views = new Map<string, RunListItem>();
    for (const [runId, runtime] of this.#runs) views.set(runId, this.listItem(runtime));
    try {
      for (const runId of await readdir(this.storeRoot)) {
        if (views.has(runId)) continue;
        try {
          const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
          views.set(runId, this.listItem(runtime));
        } catch { /* 无关文件、损坏或不兼容历史档案不影响其他 Run 总览。 */ }
      }
    } catch { /* 用户级目录尚未创建时返回当前内存 Run。 */ }
    return [...views.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 返回当前尝试首页摘要；按需从 Journal 重开，不创建或接管 Agent。 */
  private async currentAttempt(runId: string): Promise<CurrentAttemptResponse> {
    const runtime = await this.readRuntime(runId);
    return { runId, status: runtime.snapshot().status, summary: runtime.state.currentAttemptSummary() };
  }

  private listItem(runtime: RunRuntime): RunListItem {
    const item = listItem(runtime);
    const observationOnly = !this.#runTasks.has(item.runId) && [...this.#observedSessions].some((key) => key.startsWith(`${item.runId}:`));
    return observationOnly ? { ...item, observationOnly: true } : item;
  }

  private async executionAttempts(runId: string): Promise<ExecutionAttemptsResponse> {
    const runtime = await this.readRuntime(runId);
    const currentExecutionAttemptId = runtime.snapshot().currentExecutionAttemptId;
    return { runId, currentExecutionAttemptId, executionAttemptIds: runtime.state.executionAttemptIds() };
  }

  /** 返回一轮完整批次 / Agent；默认只允许当前尝试。 */
  private async phaseVisit(runId: string, phaseVisitId: number, attempt: number | null): Promise<PhaseVisitResponse> {
    if (!isPositiveInteger(phaseVisitId)) throw new DaemonRequestError(400, "phaseVisitId 无效。 ");
    const runtime = await this.readRuntime(runId);
    const executionAttemptId = attempt ?? runtime.snapshot().currentExecutionAttemptId;
    if (!runtime.state.hasExecutionAttempt(executionAttemptId)) throw new DaemonRequestError(404, "指定执行尝试不存在。 ");
    const visit = runtime.state.phaseVisitDetail(phaseVisitId, executionAttemptId);
    if (!visit) throw new DaemonRequestError(404, "指定阶段轮次不存在。 ");
    return { runId, executionAttemptId, visit };
  }

  /** 读取稳定 cursor 分页执行记录；默认隐藏无 Agent 的阶段切换。 */
  private async phaseVisits(runId: string, url: URL): Promise<PhaseVisitPageResponse> {
    const runtime = await this.readRuntime(runId);
    const attempt = parseAttempt(url) ?? runtime.snapshot().currentExecutionAttemptId;
    if (!runtime.state.hasExecutionAttempt(attempt)) throw new DaemonRequestError(404, "指定执行尝试不存在。 ");
    const cursor = parseOptionalPositiveInteger(url.searchParams.get("cursor"), "cursor");
    const limit = parseOptionalPositiveInteger(url.searchParams.get("limit"), "limit") ?? 20;
    if (limit > 100) throw new DaemonRequestError(400, "limit 不能超过 100。 ");
    const includeEmpty = url.searchParams.get("includeEmpty") === "true";
    if (url.searchParams.has("includeEmpty") && !["true", "false"].includes(url.searchParams.get("includeEmpty")!)) throw new DaemonRequestError(400, "includeEmpty 必须为 true 或 false。 ");
    const page = runtime.state.listPhaseVisits(attempt, cursor, limit, includeEmpty);
    return { runId, executionAttemptId: attempt, ...page };
  }

  private async readRuntime(runId: string): Promise<RunRuntime> {
    try { validateRunId(runId); } catch { throw new DaemonRequestError(400, "RunId 无效。 "); }
    return this.#runs.get(runId) ?? RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
  }

  private async createRunOnce(value: CreateRunRequest): Promise<RunResponse> {
    const cwd = await realpath(value.cwd);
    const workflow = await loadWorkflow(value.workflowPath, cwd);
    const sourcePath = await realpath(resolve(cwd, value.workflowPath));
    const source = await Bun.file(sourcePath).text();
    if (!this.deterministicForTest && value.workerTransport !== "codex-app-server" && !this.hasCustomRealExecutor) await this.#cliRuntimes.resolveSelected("codex");
    const baseExecutor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : value.workerTransport !== "codex-app-server" && !this.hasCustomRealExecutor
        ? new RuntimeAcpWorkerExecutor(this.#cliRuntimes, () => this.currentControlCommand())
        : this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: this.storeRoot, daemonInstanceId: this.instanceId, codexRpcInput: value.codexRpcInput !== false });
    const executor: AgentNodeExecutor = new LimitedAgentExecutor(baseExecutor, this.agentStartLimiter);
    const runtime = await RunRuntime.create({ workflow, input: value.input, workflowSource: source, clientRequestId: value.clientRequestId, workflowProjectCwd: cwd, workflowPath: sourcePath, storeRoot: this.storeRoot, executor });
    if (!this.deterministicForTest && isControlBoundExecutor(baseExecutor)) {
      const control = runtime.createControlServer();
      baseExecutor.bindControl(control);
      this.#runs.set(runtime.snapshot().id, runtime);
      this.registerControl(runtime.snapshot().id, control);
    }
    const runId = runtime.snapshot().id;
    this.#runs.set(runId, runtime);
    const task = runtime.run(workflow).catch(() => undefined).finally(() => { this.#runTasks.delete(runId); void this.closeRunTerminals(runId, "run-finished"); });
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

  /** 只允许当前 daemon 持有的真实 Run 暂停；离线 Journal 不可伪造暂停。 */
  private async pause(runId: string, value: unknown): Promise<RunResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "pause 不接受请求字段。 ");
    return this.runControl(runId, "pause", async (runtime) => {
      if (runtime.snapshot().status !== "running") throw new DaemonRequestError(409, "只有 running 的 Run 可以 pause。 ");
      await this.closeRunTerminals(runId, "paused");
      const snapshot = await runtime.pause();
      return { runId, snapshot };
    });
  }

  /** recover 只能针对当前 daemon 保留的 paused 会话，拒绝离线或历史 Run。 */
  private async recover(runId: string, value: unknown): Promise<RunResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "recover 不接受请求字段。 ");
    return this.runControl(runId, "recover", async (runtime) => {
      if (runtime.snapshot().status !== "paused") throw new DaemonRequestError(409, "只有 paused 的 Run 可以 recover。 ");
      const snapshot = await runtime.recover();
      return { runId, snapshot };
    });
  }

  private async stopRun(runId: string, value: unknown): Promise<RunResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "stop 不接受请求字段。 ");
    const active = this.#runControlRequests.get(runId);
    if (active && active.kind !== "stop") {
      const runtime = this.#runs.get(runId);
      if (!runtime) throw new DaemonRequestError(409, "该 Run 不在当前 daemon 的可控制生命周期内。 ");
      // stop 优先于 pause/recover：先取消正在等待的 App Server RPC，待其清理完
      // 控制锁后再执行真正终止，避免两个操作同时改写同一状态机。
      runtime.requestStop();
      await active.promise.catch(() => undefined);
    }
    return this.runControl(runId, "stop", async (runtime) => { await this.closeRunTerminals(runId, "stopped"); return { runId, snapshot: await runtime.stop() }; });
  }

  private async runControl(runId: string, kind: "pause" | "recover" | "stop", operation: (runtime: RunRuntime) => Promise<RunResponse>): Promise<RunResponse> {
    try { validateRunId(runId); } catch { throw new DaemonRequestError(400, "RunId 无效。 "); }
    const active = this.#runControlRequests.get(runId);
    if (active) {
      if (active.kind === kind) return active.promise;
      throw new DaemonRequestError(409, `该 Run 正在执行 ${active.kind}，不能同时执行 ${kind}。`);
    }
    const task = (async () => {
      const runtime = this.#runs.get(runId);
      if (!runtime || !this.#runTasks.has(runId)) throw new DaemonRequestError(409, "该 Run 不在当前 daemon 的可控制生命周期内。 ");
      return operation(runtime);
    })().finally(() => this.#runControlRequests.delete(runId));
    this.#runControlRequests.set(runId, { kind, promise: task });
    return task;
  }

  /** 返回首屏并确保该 Agent 的唯一 pipe-pane 观察器已就绪。 */
  private async openTerminal(runId: string, nodeId: string): Promise<TerminalOpenResponse> {
    const terminal = await this.requireTerminal(runId, nodeId);
    const initial = await terminal.observer.initialScreen();
    return { runId, nodeId, cli: terminal.node.cli, initialScreen: initial.screen, cols: initial.cols, rows: initial.rows, outputSequence: initial.sequence, wsPath: `/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/terminal/stream` };
  }

  /**
   * 用户明确请求后才认领旧会话用于观察。它不恢复 Workflow 调用栈，也不会发新 turn。
   * 成功后仅让当前 daemon 能建立 observer 与已有 Control 索引。
   */
  private async reclaimTerminal(runId: string, nodeId: string, value: unknown): Promise<ReclaimTerminalResponse> {
    if (!isEmptyObject(value)) throw new DaemonRequestError(400, "重新连接旧会话不接受请求字段。 ");
    try { validateRunId(runId); } catch { throw new DaemonRequestError(400, "RunId 无效。 "); }
    const requestKey = `${runId}:${nodeId}`;
    const active = this.#terminalReclaims.get(requestKey);
    if (active) return active;
    const previous = this.#runReclaimLocks.get(runId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.reclaimTerminalOnce(runId, nodeId)).finally(() => this.#terminalReclaims.delete(requestKey));
    const lock = task.then(() => undefined, () => undefined).finally(() => { if (this.#runReclaimLocks.get(runId) === lock) this.#runReclaimLocks.delete(runId); });
    this.#runReclaimLocks.set(runId, lock);
    this.#terminalReclaims.set(requestKey, task);
    return task;
  }

  private async reclaimTerminalOnce(runId: string, nodeId: string): Promise<ReclaimTerminalResponse> {
    let runtime = this.#runs.get(runId);
    const opened = await RunJournal.open(runId, this.storeRoot);
    if (!runtime) runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
    let node: import("../runtime/run-types").AgentNodeSnapshot;
    try { node = runtime.state.agent(nodeId); } catch { throw new DaemonRequestError(404, "该 Run 中不存在 Agent 节点。 "); }
    if ((node.status !== "running" && node.status !== "blocked") || !node.agentSessionId) throw new DaemonRequestError(409, "只有旧 running 或 blocked Agent 可以重新连接。 ");
    const sessionEvent = sessionFor(opened.events, nodeId, node.agentSessionId);
    const viewer = runtime.state.viewerSession(nodeId) ?? sessionEvent?.session;
    const binding = runtime.state.appServerBinding(nodeId) ?? sessionEvent?.appServer;
    if (!viewer?.reclaimTokenHash) throw new DaemonRequestError(409, "该旧会话缺少受管 identity，不能重新连接。 ");
    if (!await this.verifyReclaimSession(viewer, binding ? { endpoint: binding.endpoint, threadId: binding.threadId } : undefined)) throw new DaemonRequestError(409, "旧 tmux 或 App Server thread 无法验证，不能重新连接。 ");
    // 先恢复 Control。blocked 节点还会校验完整的 block Journal；任一步失败都
    // 不能让 Run 落入“已可观察”的半认领状态。
    this.restoreControl(runtime, opened, node, viewer);
    this.#runs.set(runId, runtime);
    this.#observedSessions.add(terminalKey(runId, nodeId, node.agentSessionId));
    return this.openTerminal(runId, nodeId);
  }

  /** 每次 HTTP 打开和 WebSocket 收发均重新确认当前 Run、节点状态和 tmux identity。 */
  private async requireTerminal(runId: string, nodeId: string): Promise<{ readonly key: string; readonly node: import("../runtime/run-types").AgentNodeSnapshot; readonly observer: TmuxTerminalObserver }> {
    try { validateRunId(runId); } catch { throw new DaemonRequestError(400, "RunId 无效。 "); }
    const runtime = this.#runs.get(runId);
    if (!runtime) throw new DaemonRequestError(409, "该 Run 不在当前 daemon 的可观察生命周期内。请先显式重新连接旧会话。 ");
    const controlling = this.#runControlRequests.get(runId);
    if (controlling) throw new DaemonRequestError(409, `该 Run 正在执行 ${controlling.kind}，暂不允许打开终端。`);
    if (runtime.snapshot().status !== "running") throw new DaemonRequestError(409, "当前 Run 状态不允许打开终端。 ");
    let node: import("../runtime/run-types").AgentNodeSnapshot;
    try { node = runtime.state.agent(nodeId); } catch { throw new DaemonRequestError(404, "该 Run 中不存在 Agent 节点。 "); }
    if ((node.status !== "running" && node.status !== "blocked") || !node.agentSessionId) throw new DaemonRequestError(409, "当前 Agent 状态不允许打开终端。 ");
    const session = runtime.state.viewerSession(nodeId);
    if (!session || session.agentSessionId !== node.agentSessionId) throw new DaemonRequestError(409, "该 Agent 缺少当前受管终端会话。 ");
    const key = terminalKey(runId, nodeId, node.agentSessionId);
    if (!this.#runTasks.has(runId) && !this.#observedSessions.has(key)) throw new DaemonRequestError(409, "该 Agent 不在当前 daemon 的可观察生命周期内。请先显式重新连接旧会话。 ");
    await this.#terminalClosings.get(key)?.catch(() => {});
    const existing = this.#terminals.get(key);
    if (existing) { await existing.observer.verify(); return { key, node, observer: existing.observer }; }
    let opening = this.#terminalOpenings.get(key);
    if (!opening) {
      opening = (async () => {
        const observer = this.createTerminalObserver(session);
        await observer.start();
        const sockets = new Set<ServerWebSocket<TerminalSocketData>>();
        const unsubscribe = observer.subscribe((data) => { for (const socket of sockets) socket.send(JSON.stringify({ type: "output", data })); });
        observer.onClose(() => { void this.closeTerminal(key, "session-unavailable"); });
        const entry = { observer, sockets, unsubscribe };
        this.#terminals.set(key, entry);
        return entry;
      })().finally(() => this.#terminalOpenings.delete(key));
      this.#terminalOpenings.set(key, opening);
    }
    const created = await opening;
    return { key, node, observer: created.observer };
  }

  private openTerminalSocket(socket: ServerWebSocket<TerminalSocketData>): void {
    const terminal = this.#terminals.get(socket.data.key);
    if (!terminal) { socket.send(JSON.stringify({ type: "closed", reason: "terminal-unavailable" })); socket.close(); return; }
    terminal.sockets.add(socket);
    void terminal.observer.verify().then(() => {
      if (!terminal.sockets.has(socket)) return;
      for (const data of terminal.observer.replayAfter(socket.data.after)) socket.send(JSON.stringify({ type: "output", data }));
      socket.send(JSON.stringify({ type: "ready" }));
    }).catch(() => { socket.send(JSON.stringify({ type: "closed", reason: "session-unavailable" })); socket.close(); });
  }

  private async receiveTerminalInput(socket: ServerWebSocket<TerminalSocketData>, raw: string): Promise<void> {
    let message: unknown;
    try { message = JSON.parse(raw); } catch { socket.send(JSON.stringify({ type: "error", message: "终端消息必须是 JSON。" })); return; }
    // 浏览器终端在初始化、失焦或扩展交接时可能出现非业务帧。它们既不是
    // input 也不是 resize：直接忽略，绝不转发给 tmux，也不把无害噪声显示给用户。
    // 真正可改变终端的两类消息仍在下面经过完整 shape 与 identity 校验。
    if (!isTerminalInput(message) && !isTerminalResize(message)) return;
    try {
      const terminal = await this.requireTerminal(socket.data.runId, socket.data.nodeId);
      if (terminal.key !== socket.data.key) throw new DaemonRequestError(409, "终端会话已变化。 ");
      if (isTerminalInput(message)) await terminal.observer.input(message.data);
      else {
        await terminal.observer.resize(message.cols, message.rows);
        // tmux resize 会触发 Codex 重绘，但浏览器不能靠“等下一帧”猜它何时到达。
        // 这里主动取同一 pane 的新快照，作为 resize 后的完整、可显示基线。
        await Bun.sleep(80);
        const refreshed = await terminal.observer.initialScreen();
        socket.send(JSON.stringify({ type: "reset", screen: refreshed.screen, cols: refreshed.cols, rows: refreshed.rows }));
      }
    } catch (error) { socket.send(JSON.stringify({ type: "closed", reason: error instanceof Error ? error.message : "terminal-unavailable" })); socket.close(); }
  }

  private closeTerminalSocket(socket: ServerWebSocket<TerminalSocketData>): void {
    const terminal = this.#terminals.get(socket.data.key);
    if (!terminal) return;
    terminal.sockets.delete(socket);
    if (terminal.sockets.size === 0) void this.closeTerminal(socket.data.key, "no-viewers");
  }

  private async closeRunTerminals(runId: string, reason: string): Promise<void> {
    await Promise.all([...this.#terminals.entries()].filter(([key]) => key.startsWith(`${runId}:`)).map(([key]) => this.closeTerminal(key, reason)));
  }

  /** 关闭 WebSocket 与 pipe-pane；绝不调用 tmux interrupt 或销毁 Agent。 */
  private async closeTerminal(key: string, reason: string): Promise<void> {
    if (this.#terminalClosingKeys.has(key)) return this.#terminalClosings.get(key);
    const closing = this.#terminalClosings.get(key);
    if (closing) return closing;
    const terminal = this.#terminals.get(key);
    if (!terminal) { await this.#terminalOpenings.get(key)?.catch(() => {}); if (this.#terminals.has(key)) return this.closeTerminal(key, reason); return; }
    this.#terminals.delete(key);
    this.#terminalClosingKeys.add(key);
    const task = (async () => {
      terminal.unsubscribe();
      for (const socket of terminal.sockets) { socket.send(JSON.stringify({ type: "closed", reason })); socket.close(); }
      terminal.sockets.clear();
      await terminal.observer.close().catch(() => {});
    })().finally(() => { this.#terminalClosingKeys.delete(key); this.#terminalClosings.delete(key); });
    this.#terminalClosings.set(key, task);
    return task;
  }

  private async resumeOnce(runId: string): Promise<RunResponse> {
    if (this.#runTasks.has(runId)) throw new DaemonRequestError(409, "该 Run 仍由当前 daemon 执行，不能重复 resume。 ");
    const opened = await RunJournal.open(runId, this.storeRoot);
    const resumesAcp = opened.events.some((event) => event.type === "agent.session" && event.delivery === "acp");
    if (!this.deterministicForTest && resumesAcp) await this.#cliRuntimes.resolveSelected("codex");
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
      : resumesAcp
        ? new RuntimeAcpWorkerExecutor(this.#cliRuntimes, () => this.currentControlCommand())
        : this.createRealExecutor({ controlUrl: `http://127.0.0.1:${this.#server!.port}`, runsRoot: this.storeRoot, daemonInstanceId: this.instanceId, codexRpcInput: true });
    const executor = new LimitedAgentExecutor(baseExecutor, this.agentStartLimiter);
    const runtime = await RunRuntime.resume(runId, executor, this.storeRoot);
    await this.reconcileResumeSessions(runtime, opened.events);
    if (!this.deterministicForTest && isControlBoundExecutor(baseExecutor)) {
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
      // ACP 没有可与本机进程/终端身份绑定的跨 daemon reclaim 证据。用户已显式
      // 授权 resume 时，旧 ACP session 一律 interrupted 并以新的 ACP Worker attempt
      // 重跑；绝不把 session/load 成功误称为原 Worker 身份认领。
      if (sessionEvent?.delivery === "acp") {
        unverifiable.push(node);
        continue;
      }
      const viewer = runtime.state.viewerSession(node.id) ?? sessionEvent?.session;
      const binding = runtime.state.appServerBinding(node.id) ?? sessionEvent?.appServer;
      const verified = !!viewer && await this.verifyReclaimSession(viewer, binding ? { endpoint: binding.endpoint, threadId: binding.threadId } : undefined);
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
        if (isLiveRunStatus(runtime.snapshot().status)) throw new DaemonRequestError(409, "相同创建请求的 Run 仍在受管生命周期内，但当前 daemon 未持有其权威状态；请启动或恢复 daemon。");
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
    if (isLiveRunStatus(runtime.snapshot().status)) throw new DaemonRequestError(409, "Run 仍在受管生命周期内，但当前 daemon 未持有其权威状态；请启动或恢复 daemon。");
    this.#runs.set(runId, runtime);
    return { runId, snapshot: runtime.snapshot() };
  }

  /**
   * 验证并重建旧受管 Agent 的 Control 节点；不创建 turn、不重发 Prompt。
   * 仅为本次 reclaim 控制操作恢复内存索引，Workflow 下游调度仍须用户 resume。
   */
  private async reclaimControl(request: Pick<ReclaimCompletionSubmission, "runId" | "nodeId" | "agentSessionId">): Promise<ControlServer> {
    let runtime = this.#runs.get(request.runId);
    const wasInMemory = !!runtime;
    if (!runtime) {
      runtime = await RunRuntime.open(request.runId, new DeterministicExecutor(), this.storeRoot);
    }
    // 同一 daemon 内的节点已由短期 capability 注册；显式稳定身份仅用于定位，
    // 不应再次探测真实 tmux/App Server，避免短暂探测错误影响正常控制调用。
    // 影响正常运行中的 block / complete。并行 Run 的另一个未注册节点才继续恢复。
    const active = this.#controls.get(request.runId);
    // 当前 daemon 自己启动的节点已有短期 capability 与活跃执行器，不能因一次
    // 探测瞬断中断正常控制；但跨 daemon 认领的旧会话没有这些内存保证，每次
    // complete/block/continue 都必须重新验证 tmux identity 与原 App Server thread。
    const opened = await RunJournal.open(request.runId, this.storeRoot);
    const sessionEvent = sessionFor(opened.events, request.nodeId, request.agentSessionId);
    // ACP 没有 tmux identity 可在重连时验证。当前 daemon 的 ACP Worker 必须携带
    // 短期 capability 走 active Control；稳定三元组不得退回 reclaim 路由绕过它。
    if (active?.hasNode(request.runId, request.nodeId, request.agentSessionId) && this.#runTasks.has(request.runId)) {
      if (sessionEvent?.delivery === "acp") throw new DaemonRequestError(409, "当前 ACP Worker 必须携带短期 capability 走 active Control 路由。 ");
      return active;
    }
    const viewer = runtime.state.viewerSession(request.nodeId) ?? sessionEvent?.session;
    const binding = runtime.state.appServerBinding(request.nodeId) ?? sessionEvent?.appServer;
    if (!viewer?.reclaimTokenHash) throw new DaemonRequestError(409, "该旧会话缺少受管 identity，不能跨 daemon 认领。");
    const snapshot = runtime.state.agent(request.nodeId);
    if ((snapshot.status !== "running" && snapshot.status !== "blocked") || snapshot.agentSessionId !== request.agentSessionId) throw new DaemonRequestError(409, "只能认领当前 running 或 blocked 的旧 Agent 会话。");
    if (!await this.verifyReclaimSession(viewer, binding ? { endpoint: binding.endpoint, threadId: binding.threadId } : undefined)) throw new DaemonRequestError(409, "旧 tmux 或 App Server thread 无法验证，拒绝认领。");
    if (active?.hasNode(request.runId, request.nodeId, request.agentSessionId)) return active;
    const control = this.restoreControl(runtime, opened, snapshot, viewer);
    if (!wasInMemory) this.#runs.set(request.runId, runtime);
    return control;
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
        const viewer = runtime.state.viewerSession(node.id) ?? sessionEvent?.session;
        const binding = runtime.state.appServerBinding(node.id) ?? sessionEvent?.appServer;
        if (!viewer?.reclaimTokenHash) continue;
        if (!await this.verifyReclaimSession(viewer, binding ? { endpoint: binding.endpoint, threadId: binding.threadId } : undefined)) continue;
        const control = this.restoreControl(runtime, opened, runtime.state.agent(node.id), viewer);
        this.#runs.set(runId, runtime);
        return control;
      } catch { /* 某个无关或损坏 Run 不得阻止其他 pending block 的精确路由。 */ }
    }
    return null;
  }

  /** 已验证 Session 后重建单个 Control；只恢复内存索引和 pending block。 */
  private restoreControl(runtime: RunRuntime, opened: Awaited<ReturnType<typeof RunJournal.open>>, snapshot: import("../runtime/run-types").AgentNodeSnapshot, viewer: import("../sessions/types").SessionIdentity): ControlServer {
    const existing = this.#controls.get(runtime.snapshot().id);
    if (existing?.hasNode(runtime.snapshot().id, snapshot.id, snapshot.agentSessionId!)) return existing;
    const block = snapshot.status === "blocked" ? recoveredBlock(opened.events, runtime.snapshot().id, snapshot.id, snapshot.agentSessionId!, snapshot.block?.blockRequestId) : undefined;
    if (snapshot.status === "blocked" && !block) throw new DaemonRequestError(409, "旧 blocked 节点缺少可恢复的 Journal block。");
    const control = existing ?? runtime.createControlServer();
    control.restore({ runId: runtime.snapshot().id, nodeId: snapshot.id, agentSessionId: snapshot.agentSessionId!, reclaimTokenHash: viewer.reclaimTokenHash!, session: viewer, ...(block ? { block } : {}) });
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
          const response: RunProgressEvent = { runId, status: runtime.snapshot().status, summary: runtime.state.currentAttemptSummary() };
          const serialized = JSON.stringify(response);
          if (serialized === previous) return;
          previous = serialized;
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
          if (response.status !== "running" && response.status !== "pausing" && response.status !== "recovering") {
            if (timer) clearInterval(timer);
            controller.close();
          }
        };
        publish();
        if (initial.snapshot.status === "running" || initial.snapshot.status === "pausing" || initial.snapshot.status === "recovering") timer = setInterval(publish, 200);
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

type TerminalSocketData = { readonly key: string; readonly runId: string; readonly nodeId: string; readonly after: number };

function isControlBoundExecutor(value: AgentNodeExecutor): value is ControlBoundExecutor {
  return typeof (value as Partial<ControlBoundExecutor>).bindControl === "function";
}

function terminalKey(runId: string, nodeId: string, agentSessionId: string): string { return `${runId}:${nodeId}:${agentSessionId}`; }

function isTerminalInput(value: unknown): value is { readonly type: "input"; readonly data: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as { type?: unknown }).type === "input"
    && typeof (value as { data?: unknown }).data === "string";
}

function isTerminalResize(value: unknown): value is { readonly type: "resize"; readonly cols: number; readonly rows: number } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as { type?: unknown }).type === "resize"
    && Number.isInteger((value as { cols?: unknown }).cols) && Number.isInteger((value as { rows?: unknown }).rows)
    && (value as { cols: number }).cols >= 20 && (value as { cols: number }).cols <= 500
    && (value as { rows: number }).rows >= 5 && (value as { rows: number }).rows <= 200;
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
  if (isLiveRunStatus(runtime.snapshot().status)) throw new DaemonRequestError(409, "Run 仍在受管生命周期内，但当前没有可验证的 daemon；请先启动或恢复 daemon。" );
  return { runId, snapshot: runtime.snapshot() };
}

class DaemonRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function isEmptyObject(value: unknown): value is Record<string, never> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function isCreateRunRequest(value: unknown): value is CreateRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.clientRequestId === "string" && /^[0-9a-f-]{36}$/i.test(request.clientRequestId) && typeof request.workflowPath === "string" && typeof request.cwd === "string" && isJsonObject(request.input) && (request.codexRpcInput === undefined || typeof request.codexRpcInput === "boolean") && (request.workerTransport === undefined || request.workerTransport === "codex-app-server" || request.workerTransport === "codex-acp");
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }


function listItem(runtime: RunRuntime): RunListItem {
  const snapshot = runtime.snapshot();
  const summary = runtime.state.currentAttemptSummary();
  return { runId: snapshot.id, workflow: { name: snapshot.workflow.name, description: snapshot.workflow.description }, status: snapshot.status, cwd: snapshot.cwd, createdAt: snapshot.createdAt, endedAt: snapshot.endedAt, diagnostic: snapshot.diagnostic, hasBlockedAgent: summary.phases.some((phase) => (phase.statusCounts.blocked ?? 0) > 0) };
}

function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1; }
function parseOptionalPositiveInteger(value: string | null, label: string): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value) || !isPositiveInteger(Number(value))) throw new DaemonRequestError(400, `${label} 必须是正整数。 `);
  return Number(value);
}
function parseAttempt(url: URL): number | null { return parseOptionalPositiveInteger(url.searchParams.get("attempt"), "attempt"); }

function isLiveRunStatus(status: import("../runtime/run-types").RunStatus): boolean {
  return status === "running" || status === "pausing" || status === "paused" || status === "recovering";
}
