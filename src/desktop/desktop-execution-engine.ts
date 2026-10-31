import { mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadWorkflow } from "../workflow/load-workflow";
import { inspectWorkflowModuleSource, preflightLocalWorkflow, validateLocalInput } from "../workflow/preflight-local";
import { RunRuntime } from "../runtime/run-runtime";
import { isJsonObject } from "../shared/json";
import type { JsonSchema } from "../shared/workflow-types";
import { assertAbsoluteMcpCommand } from "../shared/mcp-server-command";
import type { AnswerDecisionRequest, CliRuntimeListResponse, CreateExecutionRequest, CreateLeadProjectRequest, CreateLeadRunRequest, CreateRunRequest, CurrentAttemptResponse, DesktopStatusResponse, DiscoverCliRuntimesResponse, ExecutionAttemptsResponse, ExecutionListResponse, ExecutionPhaseVisitPageResponse, ExecutionPlanResponse, ExecutionResponse, LeadMessageRequest, LeadProjectListResponse, LeadProjectResponse, LeadCommandCatalogResponse, LeadRunListResponse, LeadRunResponse, PhaseVisitPageResponse, PhaseVisitResponse, ResumeRunRequest, RunListItem, RunResponse, ScanCliRuntimesResponse, SelectCliRuntimeResponse, StartLeadConversationRequest, ValidateCliRuntimeRequest } from "./types";
import { createHash } from "node:crypto";
import { ImpactSupplementRequiredError } from "../lead/impact-summary";
import type { ControlServer } from "../control/control-server";
import { DeterministicExecutor } from "../runtime/deterministic-executor";
import type { AgentNodeExecutor } from "../runtime/run-types";
import { leadRunsRoot, runsRoot, validateRunId } from "../journal/paths";
import { RunJournal } from "../journal/run-journal";
import { RUNTIME_VERSION } from "../journal/types";
import { AgentStartLimiter, LimitedAgentExecutor } from "../runtime/agent-start-limiter";
import { LeadService } from "../lead/service";
import { assertStartable, type TaskCreation } from "../lead/task-contract";
import { canonicalJson, isTemplateSelection, listWorkflowTemplates, validateTemplateInput } from "../lead/workflow-templates";
import { LeadProjectStore, validateProjectDirectory } from "../lead/projects";
import { readProjectContext } from "./project-context";
import { LeadExecutionService } from "../lead/executions";
import { repairLeadHomePermissions } from "../lead/journal";
import { CliRuntimeRegistry } from "../runtimes/registry";
import type { CliRuntimeRecord, DiscoveredCliCandidate, RuntimeCli } from "../runtimes/types";
import { ShellPathDiscovery } from "../runtimes/shell-path-discovery";
import { validateCliRuntime } from "../runtimes/cli-runtime-validator";
import { readCliVersion } from "../runtimes/cli-version";
import { CLI_PROBE_LIMIT, probeFirstRunnable, type CliProbeStatus } from "../runtimes/cli-probe";
import { RuntimeAcpWorkerExecutor } from "../runtime/runtime-acp-worker-executor";
import { AcpLeadSession } from "../lead/acp-lead";
import { resolveLeadLauncher, runtimeProvenance } from "../runtimes/worker-launcher-resolver";
import { DeterministicLeadSession } from "../lead/deterministic-session";
import { buildLeadSystemPrompt } from "../lead/lead-prompt";
import { WorkerControlChannel } from "../runtime/worker-control-channel";
import { LeadControlChannel } from "../lead/lead-control-channel";
import { createLeadSession } from "../lead/lead-session";
import { generateAcpTaskTitle } from "../lead/acp-task-naming";
import { prepareSessionScratch } from "../workspace/session-scratch";
import { adapterById, adapterForCli, catalogClis } from "../runtimes/adapter-catalog";
import { extractAgentWorkers } from "../workflow/extract-agents";
import { ProductionWorkspaceExecutor } from "../workspace/production-workspace-executor";
import { hasWorkspaceWriteIntent, readWorkspaceWriteIntent } from "../workspace/write-intent";
import { GitRepository } from "../workspace/git-repository";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { assertCurrentWorkspaceRecord, validateExecutionWorkspaces } from "../workspace/execution-workspaces";
import { cliUnavailableReason, isCliSelectable, isRuntimeCli } from "../shared/cli-availability";
import { managedWriteBoundaryAvailable } from "../workspace/managed-acp-transport";
import { readSkillLibrary, skillLibraryRoot } from "../skills/library";
import { missingRequiredBins, skillDependencyPath } from "../skills/dependencies";
import { discoverSkills, importSkillFromDirectory, importSkillZip } from "../skills/import";

/** 真实执行器必须在 Runtime 创建 Control 后显式绑定，避免无 capability 的受管 Agent。 */
export type ControlBoundExecutor = AgentNodeExecutor & { bindControl(control: ControlServer): void };

/**
 * Engine → Tauri 私有 JSONL 事件帧。与请求响应帧分流：无 requestId、带协议版本、
 * 流标识、会话 ID 与该流内单调序号；Tauri 校验 Engine generation 后转发给 Web。
 */
export type EngineEventFrame = {
  readonly type: "event";
  /** 事件帧协议版本；当前固定为 1。 */
  readonly protocolVersion: 1;
  /** 事件流标识；当前只有主控会话流。 */
  readonly stream: "lead";
  /** 事件归属的 Lead Run ID。 */
  readonly leadRunId: string;
  /** 该流内单调递增序号；Web 据此去重与检测漏帧，Engine 重启后重新计数并要求重读快照。 */
  readonly seq: number;
  /** 耐久事实派生的会话事件；瞬时 delta 不上帧，保证实时展示与回放同源。 */
  readonly event: import("../lead/types").LeadStreamEvent;
};

/** Desktop Execution Engine 的可选构造配置；生产默认使用用户验证的 ACP Worker。 */
export type DesktopExecutionEngineOptions = {
  /** 新Task单链/三来源契约，默认true；false仅供兼容测试，不迁移存量Task。 */
  readonly singleWorkflowForAcceptance?: boolean;
  /** 仅自动测试使用确定性执行器；不能用于用户 CLI。默认 false。 */
  readonly deterministicForTest?: boolean;
  /** 用户级 Run Store 根目录；仅测试或受控嵌入环境注入，生产默认 ~/.wave-flow/runs。 */
  readonly storeRoot?: string;
  /** Lead 对话档案根目录；仅测试或受控嵌入环境注入，生产默认 ~/.wave-flow/lead-runs。 */
  readonly leadRoot?: string;
  /**
   * Engine 状态根目录；省略时取 `leadRoot` 的同级目录（生产等于 waveFlowHome()，
   * 即 ~/.wave-flow）。仅测试或受控嵌入环境注入；用于保护 Journal/Registry 与技能库。
   */
  readonly stateRoot?: string;
  /** 全局同时运行 Run 上限；生产默认保守值，测试可缩小。 */
  readonly maxActiveRuns?: number;
  /** 全局同时启动的真实 ACP Worker 上限。 */
  readonly maxActiveAgents?: number;
  /**
   * 托管技能库根目录；省略时取设置根目录下的 `skills`（生产等于 ~/.wave-flow/skills）。
   * 仅测试或受控嵌入环境注入；所有主控/Worker 会话与 Replay 判定共用同一个根。
   */
  readonly skillsRoot?: string;
  /**
   * 技能导入发现使用的主目录；省略为当前用户 home。仅测试或受控嵌入环境注入，
   * 生产不得伪造，避免把其他用户的 CLI 技能目录当成来源。
   */
  readonly homeDir?: string;
  /** 自动测试注入；生产省略时使用 selected ACP CLI Lead。 */
  readonly createLeadSession?: (leadRunId: string, cwd: string, prior: readonly import("../lead/types").LeadMessage[], actions: import("../lead/action-tools").LeadActionCallbacks, runtime?:import("../runtimes/types").RuntimeProvenance) => Promise<import("../lead/session").LeadSession>;
  /** 测试注入独立命名器；生产省略使用所选主控ACP，无业务工具。 */
  readonly generateTaskTitle?: (context:import("../lead/task-naming").TaskNamingContext,snapshot:import("../lead/types").LeadSnapshot,signal:AbortSignal)=>Promise<string>;
  /** 测试注入的受控 PATH 发现器；生产始终使用 ShellPathDiscovery。 */
  readonly discoverCliRuntimes?: () => Promise<readonly DiscoveredCliCandidate[]>;
  /** 测试注入的完整 CLI 验证器；生产统一走 Catalog 驱动的 validateCliRuntime，执行 realpath、版本与 ACP 握手。 */
  readonly validateCliRuntime?: (cli: RuntimeCli, input: { readonly executablePath: string; readonly discoveredFrom: "shell-path" | "gui-path" | "install-dir" | "manual"; readonly discoveredShell: string | null }) => Promise<CliRuntimeRecord>;
};

/** 设置页展示的技能库状态；不包含技能正文或任何凭据。 */
export type SkillLibraryStatus = {
  /** 技能库根目录绝对路径。 */
  readonly root: string;
  /** 扫描时目录是否存在；缺失不是错误。 */
  readonly exists: boolean;
  /** 库摘要；空库为 null。 */
  readonly digest: string | null;
  /** 合法 skill 数量。 */
  readonly count: number;
  /**
   * 合法 skill 与其依赖诊断；只读展示，不安装依赖、不修改 Worker PATH。
   * `missingBins` 只表示当前 Engine 可见 PATH 中找不到，不覆盖各 CLI 自己的 node 目录。
   */
  readonly skills: readonly {
    /** skill 名称。 */
    readonly name: string;
    /** frontmatter description。 */
    readonly description: string;
    /** SKILL.md 字节数。 */
    readonly bytes: number;
    /** frontmatter `metadata.requires.bins` 声明的可执行文件名。 */
    readonly requiredBins: readonly string[];
    /** 当前诊断 PATH 中找不到的可执行文件名；空数组表示未发现缺失。 */
    readonly missingBins: readonly string[];
  }[];
  /** 所有 skill 声明中缺失的依赖并集；供设置页一次性提示。 */
  readonly missingDependencies: readonly string[];
  /** 被跳过、不参与注入的非法 skill；不影响其他合法项。 */
  readonly invalid: readonly { readonly name: string; readonly issue: string }[];
  /** 每个可选 CLI 的执行期注入能力；未声明注入时 unsupported。 */
  readonly capabilities: readonly { readonly cli: RuntimeCli; readonly displayName: string; readonly injection: "verified" | "unsupported" }[];
  /** 暂时下线的 CLI 与原因；仅用于设置页说明，不提供选择入口。 */
  readonly unavailable: readonly { readonly cli: RuntimeCli; readonly reason: string }[];
};

/**
 * Desktop 唯一的执行状态权威。
 *
 * 此类不监听端口、不发布发现信息；Tauri 仅通过私有进程管道调用业务方法。
 */
export class DesktopExecutionEngine {
  #runs = new Map<string, RunRuntime>();
  #controls = new Map<string, ControlServer>();
  #runTasks = new Map<string, Promise<unknown>>();
  #lead: LeadService;
  /** 侧边栏耐久项目；Lead 从项目继承 cwd。 */
  #projects: LeadProjectStore;
  /** Lead 生成脚本的 WorkflowExecution 服务；Execution 不进入 Run 列表。 */
  #executions: LeadExecutionService;
  /** 所有 ACP Worker 必须使用用户确认且启动前复核的本机 CLI Runtime。 */
  #cliRuntimes: CliRuntimeRegistry;
  /** 托管技能库根；主控、Worker 与 Replay 判定共用，生产等于 ~/.wave-flow/skills。 */
  private readonly skillsRoot: string;
  /** 技能导入发现使用的主目录；生产为用户 home，测试可注入。 */
  private readonly homeDirectory: string;
  /** 同一 Engine 内启动扫描单飞，避免并发页面加载重复握手和覆盖 Registry。 */
  #runtimeScan: Promise<ScanCliRuntimesResponse> | null = null;
  /** 每条 Lead ACP session 的随机私有 MCP 控制 socket；只在 Engine 内存存活。 */
  #leadControlPipes = new Map<string, LeadControlChannel>();
  /** 当前 Engine 内每个真实 Worker 的私有 Control socket；从不发布或持久化。 */
  #workerControlPipes = new Map<string, WorkerControlChannel>();
  /** 当前Engine的受管writer证明对象；终态后保留用于显式partial收尾，不跨进程认领。 */
  #workspaceExecutors = new Map<string, ProductionWorkspaceExecutor>();
  /** ACP 缺少跨 Engine identity；仅提供诚实 UI 提示，绝不伪造 session 认领。 */
  #acpWorkersNeedingResume = 0;
  #createRequests = new Map<string, Promise<RunResponse>>();
  /** 同一 Run 的并发 resume 只允许一个授权重放事务，防止重复新 attempt。 */
  #resumeRequests = new Map<string, Promise<RunResponse>>();
  /** 同一 Run 的用户控制必须串行；不同动作不能误复用彼此的成功结果。 */
  #runControlRequests = new Map<string, { readonly kind: "pause" | "recover" | "stop"; readonly promise: Promise<RunResponse> }>();
  /** 明确退出一旦开始，禁止再接受会产生或改变业务状态的新 Desktop action。 */
  #exitRequested = false;
  /** Engine 事件总线的订阅者；engine-main 注册后把事件帧写入私有 JSONL 通道。 */
  #eventSinks = new Set<(frame: EngineEventFrame) => void>();
  /** 每个 Lead 流的单调序号；Engine 进程内重新计数，Web 重启后必须重读快照对齐。 */
  #leadEventSeq = new Map<string, number>();
  readonly instanceId = crypto.randomUUID();

  private readonly deterministicForTest: boolean;
  /** 验收入口开关；默认关闭，存量档案仍按自身契约只读/恢复。 */
  private readonly singleWorkflowForAcceptance: boolean;
  private readonly storeRoot: string;
  private readonly leadRoot: string;
  private readonly workspaceRoot: string;
  private readonly maxActiveRuns: number;
  private readonly agentStartLimiter: AgentStartLimiter;
  private readonly hasCustomLeadSession: boolean;
  private readonly discoverCliRuntimeCandidates: () => Promise<readonly DiscoveredCliCandidate[]>;
  private readonly validateCliRuntimeCandidate: NonNullable<DesktopExecutionEngineOptions["validateCliRuntime"]>;

  /**
   * @param options 自动测试可选择确定性执行器；生产只启动用户验证的 ACP Worker。
   * 为保持已有测试调用兼容，也接受历史 boolean 形式；用户 CLI 不会传入该参数。
   */
  constructor(options: DesktopExecutionEngineOptions | boolean = {}) {
    const normalized = typeof options === "boolean" ? { deterministicForTest: options } : options;
    this.deterministicForTest = normalized.deterministicForTest === true;
    // 新建Task默认启用联合验收后的单链/三来源/修订续作；false仅供存量兼容测试。
    this.singleWorkflowForAcceptance = normalized.singleWorkflowForAcceptance !== false;
    this.storeRoot = normalized.storeRoot ?? runsRoot();
    const leadRoot = normalized.leadRoot ?? leadRunsRoot();
    this.leadRoot = leadRoot;
    this.workspaceRoot=join(dirname(this.storeRoot),"workspaces");
    this.#projects = new LeadProjectStore(dirname(leadRoot));
    this.#cliRuntimes = new CliRuntimeRegistry(dirname(leadRoot));
    // 生产状态与 Lead 档案同属 waveFlowHome；注入 leadRoot 时默认取它的同级目录。
    // 同一 root 也是主控写边界要保护的 Engine 状态目录，保证测试注入与生产语义一致。
    const stateRoot = normalized.stateRoot ?? dirname(leadRoot);
    this.skillsRoot = normalized.skillsRoot ?? skillLibraryRoot(stateRoot);
    this.homeDirectory = normalized.homeDir ?? homedir();
    this.discoverCliRuntimeCandidates = normalized.discoverCliRuntimes ?? (() => new ShellPathDiscovery().discover());
    this.validateCliRuntimeCandidate = normalized.validateCliRuntime ?? ((cli, input) => validateCliRuntime(cli, input));
    this.hasCustomLeadSession = normalized.createLeadSession !== undefined || this.deterministicForTest;
    const leadFactory = normalized.createLeadSession ?? (this.deterministicForTest
      ? async () => new DeterministicLeadSession()
      : async (leadRunId: string, cwd: string, prior: readonly import("../lead/types").LeadMessage[], _actions: import("../lead/action-tools").LeadActionCallbacks, frozenRuntime?: import("../runtimes/types").RuntimeProvenance) => {
      const runtime = frozenRuntime ? await this.#cliRuntimes.resolveByIdLead(frozenRuntime.runtimeId) : await this.#cliRuntimes.resolveSelectedLead();
      const compiled = import.meta.dir.startsWith("/$bunfs/");
      const command = process.execPath;
      const scratch = await prepareSessionScratch(join(dirname(leadRoot), "lead-scratch"), cwd);
      const pipe = new LeadControlChannel(request => this.#lead.mcpTools(leadRunId, request), scratch);
      this.#leadControlPipes.set(leadRunId, pipe);
      const args = compiled ? ["__lead-mcp"] : [join(import.meta.dir, "../desktop/engine-main.ts"), "__lead-mcp"];
      const mcpServer = { name: "wave-flow-lead", command, args, env: [
        { name: "WF_LEAD_CONTROL_SOCKET", value: pipe.endpoints.socketPath },
      ] } as any;
      assertAbsoluteMcpCommand(mcpServer);
      let session: AcpLeadSession;
      try { session = await createLeadSession({ engineHome: stateRoot, launcher: resolveLeadLauncher(runtime), cwd, scratch, prompt: buildLeadSystemPrompt(), prior, mcp: mcpServer, skills: adapterById(runtime.verifiedAdapter.adapterId)?.skills ?? null, skillsRoot: this.skillsRoot }); }
      catch (error) { pipe.close(); this.#leadControlPipes.delete(leadRunId); throw error; }
      const close = session.close.bind(session); session.close = () => { pipe.close(); this.#leadControlPipes.delete(leadRunId); close(); };
      return session;
    });
    this.#lead = new LeadService(leadRoot, leadFactory, undefined, async () => {
      if (this.hasCustomLeadSession) return { fingerprint: "injected-lead-session" };
      const runtime = await this.#cliRuntimes.resolveSelectedLead();
      return { fingerprint: createHash("sha256").update(`${runtime.runtimeId}\n${runtime.executablePath}\n${runtime.version}\n${runtime.verifiedAdapter.adapterId}\n${runtime.verifiedAdapter.adapterVersion}`).digest("hex"), runtime: runtimeProvenance(runtime) };
    }, this.singleWorkflowForAcceptance);
    if(normalized.generateTaskTitle)this.#lead.setNamingGenerator(normalized.generateTaskTitle);
    else if(!this.hasCustomLeadSession)this.#lead.setNamingGenerator(async(context,snapshot,signal)=>{
      const runtime=snapshot.runtime ? await this.#cliRuntimes.resolveByIdLead(snapshot.runtime.runtimeId) : await this.#cliRuntimes.resolveSelectedLead();
      return generateAcpTaskTitle({launcher:resolveLeadLauncher(runtime),projectCwd:snapshot.cwd,scratchRoot:join(dirname(leadRoot),"naming-scratch"),context,signal});
    });
    // 事件总线：只把耐久事实派生的事件推给订阅者；瞬时 reasoning/assistant delta 不上帧，
    // Web 实时展示与重开回放因此始终同源（Journal → 投影/事件帧）。
    this.#lead.addEventListener((leadRunId, event) => this.publishLeadEvent(leadRunId, event));
    this.#executions = new LeadExecutionService(this.#lead, (config) => this.createExecutionExecutor(config), {
      wireControl: (runtime, wiring) => this.wireExecutionControl(runtime, wiring),
      prepareResume: async (executionId, snapshot) => {
        const original = this.#workspaceExecutors.get(executionId);
        if (!original) return; // 新Engine不认领旧writer，后续现场/退出核验仍fail closed。
        for (const node of snapshot.phases.flatMap(phase => phase.agents)) if (node.status === "completed") await original.finalizeCompleted(node);
      },
    }, leadRoot, this.storeRoot,this.workspaceRoot, this.skillsRoot);
    this.#lead.setExecutionCapsuleReader((taskId, executionId, attempt) => this.#executions.capsuleEvidence(taskId, executionId, attempt));
    this.#lead.setExecutionSceneReader((taskId, executionId) => this.#executions.sceneEvidence(taskId, executionId));
    this.maxActiveRuns = normalized.maxActiveRuns ?? 20;
    if (!Number.isInteger(this.maxActiveRuns) || this.maxActiveRuns < 1) throw new Error("maxActiveRuns 必须是不小于 1 的整数。");
    this.agentStartLimiter = new AgentStartLimiter(normalized.maxActiveAgents ?? 20);
  }

  /** 释放当前 Desktop Execution Engine 的内存会话；不会删除 Journal 或本地结果文件。 */
  shutdown(): void {
    this.#lead.close();
    for (const pipe of this.#leadControlPipes.values()) pipe.close();
    this.#leadControlPipes.clear();
    for (const pipe of this.#workerControlPipes.values()) pipe.close();
    this.#workerControlPipes.clear();
  }

  /** 有界后台主控检查；不影响启动ready或自动恢复任务，创建时仍做相同兜底检查。 */
  refreshSelectedLead():void { if(!this.deterministicForTest)void this.#cliRuntimes.refreshSelectedLead().catch(()=>{}); }

  /** 订阅 Engine 事件帧；engine-main 在启动时注册，把帧写入私有 JSONL stdout。 */
  subscribeEvents(sink: (frame: EngineEventFrame) => void): () => void { this.#eventSinks.add(sink); return () => this.#eventSinks.delete(sink); }

  /** 只发布耐久事实派生的事件；瞬时 delta 与 ACP 原始通知不上帧（已由条目事件承载）。 */
  private publishLeadEvent(leadRunId: string, event: import("../lead/types").LeadStreamEvent): void {
    if (this.#eventSinks.size === 0) return;
    if (event.type !== "entry_started" && event.type !== "entry_appended" && event.type !== "entry_finished" && event.type !== "turn_finished" && event.type !== "turn_interrupted" && event.type !== "execution_changed" && event.type !== "title_changed" && event.type !== "commands_changed") return;
    const seq = (this.#leadEventSeq.get(leadRunId) ?? 0) + 1;
    this.#leadEventSeq.set(leadRunId, seq);
    const frame: EngineEventFrame = { type: "event", protocolVersion: 1, stream: "lead", leadRunId, seq, event };
    for (const sink of this.#eventSinks) sink(frame);
  }

  /** Desktop 明确退出：先耐久取消，再由 Runtime/Executor 尽力停止受管 Worker。 */
  async cancelForDesktopExit(): Promise<void> {
    if (this.#exitRequested) return;
    this.#exitRequested = true;
    this.#lead.beginExit();
    let failure: unknown;
    for(const runtime of this.#runs.values()) {
      try { await runtime.cancelForDesktopExit(this.instanceId); } catch (error) { failure ??= error; }
    }
    try { await this.#executions.cancelForDesktopExit(this.instanceId); } catch (error) { failure ??= error; }
    try { await this.#lead.interruptForDesktopExit(); } catch (error) { failure ??= error; }
    this.#lead.close();
    for (const pipe of this.#leadControlPipes.values()) pipe.close();
    this.#leadControlPipes.clear();
    for (const pipe of this.#workerControlPipes.values()) pipe.close();
    this.#workerControlPipes.clear();
    if (failure !== undefined) throw failure;
  }


  /** Engine 重启后，所有未终结节点一律 interrupted；恢复只能由用户显式 resume 发起。 */
  async convergeStaleAcpWorkers(): Promise<void> {
    let runIds: readonly string[] = [];
    // 全局 Run Store 不存在（纯 Lead 使用）不能提前返回：下方 Lead Execution
    // 与主控回合的收敛与全局 Store 无关，跳过会让失联 Execution 停在"工作中"。
    try { runIds = await readdir(this.storeRoot); } catch { runIds = []; }
    for (const runId of runIds) {
      try {
        const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
        let interrupted = false;
        for (const node of runtime.snapshot().phases.flatMap(phase => phase.agents)) {
          if (node.status === "completed" || node.status === "cancelled" || node.status === "interrupted") continue;
          const event: import("../journal/types").JournalEvent = {
            type: "agent.status", at: new Date().toISOString(), runId,
            nodeId: node.id, agentSessionId: node.agentSessionId,
            diagnostic: node.agentSessionId
              ? "Desktop Engine 重启后无法跨进程验证原 ACP 会话；等待用户显式 resume。"
              : "Desktop Engine 重启时节点尚未取得可验证会话；等待用户显式 resume。",
            status: "interrupted",
          };
          await runtime.commitConvergence(event);
          if (node.agentSessionId) this.#acpWorkersNeedingResume += 1;
          interrupted = true;
        }
        // 即使崩溃恰好发生在第一个节点投递前，原 Workflow 调用栈同样已经丢失。
        // 因而任何 live Run 都必须收敛，不能因为还没有 ACP session 而留在 running。
        if (isLiveRunStatus(runtime.snapshot().status)) {
          const event: import("../journal/types").JournalEvent = {
            type: "run.status", at: new Date().toISOString(), runId,
            nodeId: null, agentSessionId: null,
            diagnostic: interrupted
              ? "Desktop Engine 重启后存在未终结节点；等待用户显式 resume。"
              : "Desktop Engine 重启时原 Workflow 调用栈已丢失；等待用户显式 resume。",
            status: "interrupted",
          };
          await runtime.commitConvergence(event);
        }
        // 启动收敛后的 Run 已经是离线终态，不能放入 #runs（该表只代表当前
        // Engine 持有的可控会话）。后续只读查询会从刚更新的 Journal 重开。
      } catch { /* 单一 archive 损坏不能阻断其他旧会话。 */ }
    }
    // LeadExecution 的嵌套 Run 不在全局 Run Store，因此上面的扫描覆盖不到。
    // 必须按 Lead 档案再次收敛，避免重启后 Web 把已失联的 Worker 显示为工作中。
    // 先修复旧版本以 0755 创建的状态目录权限：否则读取校验会让档案对收敛不可见，
    // 失联 Execution 永远停在"工作中"。再按目录项逐个收敛而不是 LeadService.list()：
    // list() 会静默丢弃读取失败的档案，恰好让最需要收敛的档案逃过收敛。
    await repairLeadHomePermissions(this.leadRoot);
    let leadIds: readonly string[] = [];
    try { leadIds = await readdir(this.leadRoot); } catch { leadIds = []; }
    for (const leadRunId of leadIds) {
      try {
        await this.#executions.convergeStaleExecutions(leadRunId);
      }
      catch { /* 单一 Lead 或嵌套档案损坏不能阻断其他会话。 */ }
    }
    await this.#lead.convergeStaleTurns();
    await this.#lead.resumeMessageQueues();
    await this.#lead.resetAttachmentStaging();
  }

  /** 注册一个真实 Run 的 ControlServer；必须与当前 Engine 中的同一 Run 绑定。 */
  registerControl(runId: string, control: ControlServer): void {
    const runtime = this.#runs.get(runId);
    if (!runtime || runtime.journal.manifest.runId !== runId) throw new Error("只能为当前 Engine 已知的 Run 注册 ControlServer。");
    if (this.#controls.has(runId)) throw new Error("该 Run 的 ControlServer 已注册。");
    this.#controls.set(runId, control);
  }

  /** Execution 的底座执行器；Lead 执行只走用户已验证的本机 ACP Worker 或测试确定性执行器。 */
  private createExecutionExecutor(config: import("../lead/types").ExecutionConfigSnapshot | null): { readonly executor: AgentNodeExecutor; readonly wiring?: unknown } {
    if (this.deterministicForTest) return { executor: new LimitedAgentExecutor(new DeterministicExecutor(), this.agentStartLimiter) };
    const fallbackRuntimeId = config && config.assignmentMode !== "script" ? config.fallbackRuntimeId : null;
    if (config?.workspaces) {
      const base = new ProductionWorkspaceExecutor(config.workspaces, this.workspaceRoot, this.instanceId, this.#cliRuntimes, (identity, scratch) => this.workerControlMcp(identity, scratch), fallbackRuntimeId, this.skillsRoot);
      return { executor: new LimitedAgentExecutor(base, this.agentStartLimiter), wiring: base };
    }
    const base: AgentNodeExecutor = new RuntimeAcpWorkerExecutor(this.#cliRuntimes, (identity, scratch) => this.workerControlMcp(identity, scratch), undefined, fallbackRuntimeId, join(dirname(this.storeRoot), "read-only-scratch"), this.skillsRoot);
    return { executor: new LimitedAgentExecutor(base, this.agentStartLimiter), wiring: base };
  }

  /**
   * Execution 复用与 Run 完全相同的 Control 边界：ControlServer 以 Execution 的内嵌
   * runId 注册，Worker 的 complete/block/continue 经本节点私有控制 socket MCP 到达 Control，
   * 不知道自己在 Execution 中。
   */
  private async wireExecutionControl(runtime: RunRuntime, wiring: unknown): Promise<void | (() => void)> {
    if (this.deterministicForTest || !wiring || (!(wiring instanceof ProductionWorkspaceExecutor) && !isControlBoundExecutor(wiring as AgentNodeExecutor))) return;
    const control = runtime.createControlServer();
    const runId = runtime.journal.manifest.runId;
    if (this.#controls.has(runId)) throw new Error("该 Execution 的 ControlServer 已注册。 ");
    this.#controls.set(runId, control);
    try {
      if (wiring instanceof ProductionWorkspaceExecutor) await wiring.bindRuntime(runtime, control);
      else (wiring as ControlBoundExecutor).bindControl(control);
    } catch (error) { this.#controls.delete(runId); throw error; }
    if (wiring instanceof ProductionWorkspaceExecutor) this.#workspaceExecutors.set(runId,wiring);
    // 释放器捕获具体 Control 身份，不按 runId 误删 resume 后的新控制资源。
    return () => { if (this.#controls.get(runId) === control) this.#controls.delete(runId); if (wiring instanceof ProductionWorkspaceExecutor) wiring.close(); };
  }


  /** 创建独立 Lead 对话，不创建 Workflow Run、Worker 或 Control。 */
  private async createLead(value: unknown): Promise<LeadRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as CreateLeadRunRequest).projectId !== "string") throw new EngineActionError(400, "创建 Lead 请求无效。 ");
    try {
      const project = await this.#projects.get((value as CreateLeadRunRequest).projectId);
      if (!this.hasCustomLeadSession) await this.#cliRuntimes.resolveSelectedLead();
      const lead = await this.#lead.create(project.cwd, project.projectId);
      await this.#projects.touch(project.projectId);
      return { lead };
    } catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }
  /** 首条消息是新 Lead 的持久化边界；UI 草稿从不通过此路径前写入 Engine。 */
  private async startLeadConversation(projectId: string, value: unknown): Promise<LeadRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as StartLeadConversationRequest).projectId !== "string" || (value as StartLeadConversationRequest).projectId !== projectId || typeof (value as StartLeadConversationRequest).text !== "string") throw new EngineActionError(400, "新会话首条消息请求无效。 ");
    try {
      const project = await this.#projects.get(projectId);
      // 唯一新建任务路径：缺失重试身份拒绝，旧档案仍兼容读取。
      const lead = await this.#lead.startTask(project.cwd, value as TaskCreation);
      await this.#projects.touch(project.projectId);
      return { lead };
    } catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }
  private async listProjects(): Promise<LeadProjectListResponse> { return { projects: await this.#projects.list() }; }
  /** 只发现当前主控 CLI 的斜杠命令/技能；不创建 Lead、Task 或 Journal。 */
  private async leadCommandCatalog(value: unknown): Promise<LeadCommandCatalogResponse> {
    const project = await this.#projects.get(requiredString(value, "projectId"));
    const runtime = this.hasCustomLeadSession ? undefined : await this.#cliRuntimes.resolveSelectedLead();
    return { commands: await this.#lead.commandCatalog(project.cwd, runtime?.runtimeId) };
  }
  /** Worker 专属 MCP 只代理当前节点的 Control；token/capability 不会进入 Web 或 Journal。 */
  private workerControlMcp(identity: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string; readonly resultSchema?: JsonSchema }, scratch?: string): import("@agentclientprotocol/sdk").McpServer {
    const control = this.#controls.get(identity.runId);
    if (!control) throw new Error("Worker MCP 创建时找不到当前 Engine 的 ControlServer。 ");
    const key = `${identity.runId}\0${identity.nodeId}\0${identity.agentSessionId}`;
    if (this.#workerControlPipes.has(key)) throw new Error("当前 Worker 已有私有 Control 通道。 ");
    // 通道身份只有四项绑定坐标。节点结果 Schema 属于工具声明，必须留在 MCP 配置里，
    // 不能混进每次 complete/block/continue 的上报请求。
    const pipe = new WorkerControlChannel(control, {
      runId: identity.runId,
      nodeId: identity.nodeId,
      agentSessionId: identity.agentSessionId,
      capability: identity.capability,
    }, () => this.#workerControlPipes.delete(key), scratch);
    this.#workerControlPipes.set(key, pipe);
    const command = process.execPath;
    const compiled = import.meta.dir.startsWith("/$bunfs/");
    const args = compiled ? ["__worker-mcp"] : [join(import.meta.dir, "../desktop/engine-main.ts"), "__worker-mcp"];
    const server = { name: "wave-flow-worker-control", command, args, env: [
        { name: "WF_WORKER_CONTROL_SOCKET", value: pipe.endpoints.socketPath },
        // 本节点声明了结果 Schema 时一并下发：sidecar 把它内联进完成工具的 inputSchema。
        // 工具定义每次请求都会重发，是唯一不随对话历史被压缩折叠的完成条件载体。
        ...(identity.resultSchema ? [{ name: "WF_WORKER_RESULT_SCHEMA", value: JSON.stringify(identity.resultSchema) }] : []),
      ] };
    assertAbsoluteMcpCommand(server);
    return {
      ...server,
      close: () => { pipe.close(); this.#workerControlPipes.delete(key); },
    } as any;
  }

  private async createProject(value: unknown): Promise<LeadProjectResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as CreateLeadProjectRequest).cwd !== "string" || ((value as CreateLeadProjectRequest).title !== undefined && typeof (value as CreateLeadProjectRequest).title !== "string")) throw new EngineActionError(400, "创建项目请求无效。 ");
    try { return { project: await this.#projects.create((value as CreateLeadProjectRequest).cwd, (value as CreateLeadProjectRequest).title) }; }
    catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 返回设置页可展示的 Runtime；不暴露文件身份、PATH 或任何环境变量。 */
  private async listCliRuntimes(): Promise<CliRuntimeListResponse> { return this.#cliRuntimes.list(); }

  /**
   * 设置页技能库状态：只读扫描，不创建目录、不启动进程、不读取技能正文。
   * 非法库在这里如实报错，由 UI 展示为可操作诊断，不静默当作空库。
   */
  private async skillStatus(): Promise<SkillLibraryStatus> {
    let library: import("../skills/types").SkillLibrary;
    try { library = await readSkillLibrary(this.skillsRoot); }
    catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
    const capabilities = catalogClis().filter(isCliSelectable).map((cli) => {
      const entry = adapterForCli(cli);
      return { cli, displayName: entry.displayName, injection: entry.skills?.verified ? "verified" as const : "unsupported" as const };
    });
    const unavailable = catalogClis().filter(cli => !isCliSelectable(cli)).map(cli => ({ cli, reason: cliUnavailableReason(cli) ?? "该 CLI 已暂时下线。" }));
    const pathValue = skillDependencyPath();
    const skills = await Promise.all(library.skills.map(async skill => ({
      name: skill.name,
      description: skill.description,
      bytes: skill.bytes,
      requiredBins: skill.requiredBins,
      missingBins: await missingRequiredBins(skill.requiredBins, pathValue),
    })));
    const missingDependencies = [...new Set(skills.flatMap(skill => skill.missingBins))];
    return { root: library.root, exists: library.exists, digest: library.digest, count: library.skills.length, skills, missingDependencies, invalid: library.invalid ?? [], capabilities, unavailable };
  }

  /** 扫描本机 CLI 技能目录，返回可导入候选；只读，不复制。 */
  private async discoverSkills(): Promise<import("../skills/import").SkillDiscoverResult> {
    try { return await discoverSkills(this.skillsRoot, this.homeDirectory); }
    catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 从已识别的 CLI 技能目录导入一个 skill；同名目标拒绝，不覆盖。 */
  private async importSkill(value: unknown): Promise<{ readonly name: string }> {
    const path = requiredString(value, "path");
    try {
      const imported = await importSkillFromDirectory(path, this.skillsRoot, this.homeDirectory);
      // 让新建或空闲重开的主控会话按新库重新投影；活动会话不回改。
      this.#lead.closeIdleSessions();
      return { name: imported.name };
    } catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 从用户选择的 skill.zip 导入一个 skill；展开前做路径/大小/条目校验。 */
  private async importSkillArchive(value: unknown): Promise<{ readonly name: string }> {
    const path = requiredString(value, "path");
    try {
      const imported = await importSkillZip(path, this.skillsRoot);
      this.#lead.closeIdleSessions();
      return { name: imported.name };
    } catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  /** 用户显式点击后打开技能库目录；缺失时创建空目录，不写任何示例 skill。 */
  private async openSkillLibrary(): Promise<{ readonly opened: true }> {
    await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 });
    if (process.platform === "darwin") {
      // /usr/bin/open 是 macOS 自带工具；缺失时给出可复制的路径，而不是裸露的 spawn 错误。
      try {
        const child = Bun.spawn(["/usr/bin/open", this.skillsRoot], { stdio: ["ignore", "ignore", "ignore"] });
        child.unref();
      } catch (error) {
        throw new EngineActionError(500, `无法打开技能库目录（/usr/bin/open 不可用：${error instanceof Error ? error.message : String(error)}）；请手动打开 ${this.skillsRoot}。 `);
      }
    }
    return { opened: true };
  }

  /** 仅保留为诊断接口；启动扫描应使用 scan，由 Engine 负责验证和安全写入。 */
  private async discoverCliRuntimes(value: unknown): Promise<DiscoverCliRuntimesResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, "扫描本机 CLI 不接受请求字段。 ");
    try { return { candidates: (await this.discoverCliRuntimeCandidates()).filter(candidate => isCliSelectable(candidate.cli)) }; }
    catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  /**
   * 自动扫描只发现、验证并保存候选，绝不写 selectedByCli。
   * 与 Orca 的 runnable-command 语义一致：每个 CLI 只取发现顺序中第一个可运行候选，
   * 不把机器上的每个安装都保存成并列选项；其他安装仍可由用户手动验证显式加入。
   * 顺序也与之对齐：先用有界 `--version` 探测挑出可运行候选，再对它做一次完整 ACP 验证，
   * 不让每个候选都承担一次握手；探测结论回传给 UI，不能把"没探测出来"说成"没安装"。
   * 页面每次启动触发一次；单飞只合并同一时刻请求，不把失败当成默认项变更。
   */
  private async scanCliRuntimes(value: unknown): Promise<ScanCliRuntimesResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, "扫描本机 CLI 不接受请求字段。 ");
    if (!this.#runtimeScan) this.#runtimeScan = (async () => {
      const candidates = await this.discoverCliRuntimeCandidates();
      let verified = 0;
      const failures: Partial<Record<RuntimeCli, CliProbeStatus>> = {};
      for (const cli of catalogClis().filter(isCliSelectable)) {
        const list = candidates.filter((candidate) => candidate.cli === cli);
        if (list.length === 0) { failures[cli] = "absent"; continue; }
        let offset = 0;
        while (offset < list.length) {
          const window = list.slice(offset, offset + CLI_PROBE_LIMIT);
          const probe = await probeFirstRunnable(window.map((candidate) => candidate.executablePath));
          // 探测只是排序与诊断：`--version` 跑不起来不等于 ACP 不可用（例如
          // node 入口需要 Engine 解析的 node），因此探测无结论时仍对首个候选做一次
          // 完整验证，失败再如实报告探测结论。
          const candidate = probe.status === "available" && probe.binary
            ? window.find((item) => item.executablePath === probe.binary) ?? window[0]!
            : window[0]!;
          try {
            await this.#cliRuntimes.saveVerified(await this.validateCliRuntimeCandidate(cli, candidate));
            verified += 1;
            delete failures[cli];
            break;
          } catch {
            // 探测无结论或 ACP 握手失败：继续验证后面的候选，失败原因留在 failures。
            failures[cli] = probe.status === "available" ? "exec_failed" : probe.status;
            offset = list.indexOf(candidate) + 1;
          }
        }
      }
      return { discovered: candidates.length, verified, failures, runtimes: await this.#cliRuntimes.list() };
    })().finally(() => { this.#runtimeScan = null; });
    try { return await this.#runtimeScan; }
    catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  /**
   * 按可执行文件名与 `--version` 输出识别真实 CLI 种类。
   * 用户手选的“CLI 种类”只是意图，路径才是事实：把 Kimi 二进制当 Codex 启动会得到
   * 上游适配器的英文进程退出错误，正常用户无法自行判断。无法识别时返回 null，仍按用户选择验证。
   */
  private async detectCliKind(executablePath: string): Promise<RuntimeCli | null> {
    const base = executablePath.split("/").pop()?.toLowerCase() ?? "";
    for (const { cli, keyword } of CLI_KIND_KEYWORDS) if (base.includes(keyword)) return cli;
    try {
      const version = (await readCliVersion(executablePath, "CLI")).toLowerCase();
      for (const { cli, keyword } of CLI_KIND_KEYWORDS) if (version.includes(keyword)) return cli;
    } catch { /* 版本读不出来不是验证失败；继续按用户选择的种类验证。 */ }
    return null;
  }

  /** 验证固定 adapter 与用户明确给出的绝对 CLI 路径；成功也不自动选为默认。 */
  private async validateCliRuntime(value: unknown): Promise<SelectCliRuntimeResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as ValidateCliRuntimeRequest).executablePath !== "string" || !catalogClis().includes((value as ValidateCliRuntimeRequest).cli)) throw new EngineActionError(400, "CLI Runtime 验证请求无效。 ");
    const request = value as ValidateCliRuntimeRequest;
    if (!isCliSelectable(request.cli)) throw new EngineActionError(400, cliUnavailableReason(request.cli) ?? "该 CLI 已暂时下线。");
    const discoveredFrom = request.discoveredFrom ?? "manual";
    if (!["shell-path", "gui-path", "install-dir", "manual"].includes(discoveredFrom) || (request.discoveredShell !== undefined && request.discoveredShell !== null && typeof request.discoveredShell !== "string")) throw new EngineActionError(400, "CLI Runtime 验证来源无效。 ");
    const detected = await this.detectCliKind(request.executablePath);
    // 已识别出真实种类时以它为准；识别不出但仍失败时再依次试其他种类，避免用户被种类选择卡死。
    const kinds: RuntimeCli[] = (detected === request.cli ? [request.cli] : detected ? [detected, request.cli] : [request.cli, ...catalogClis().filter(cli => cli !== request.cli)]).filter(isCliSelectable);
    let failure: unknown;
    for (const cli of kinds) {
      try {
        const verified = await this.validateCliRuntimeCandidate(cli, { executablePath: request.executablePath, discoveredFrom, discoveredShell: request.discoveredShell ?? null });
        const stored = await this.#cliRuntimes.saveVerified(verified); const { executableIdentity: _identity, ...runtime } = stored;
        return { runtime };
      } catch (error) { failure ??= error; }
    }
    throw new EngineActionError(400, describeCliValidationFailure(failure, request.cli));
  }


  /** 创建 Execution/Run 前的存在性预检：任一 cli 有已验证的 Worker 候选即可；逐节点仍按 cli fail closed。 */
  private async requireWorkerCandidate(): Promise<void> {
    if (!await this.#cliRuntimes.hasWorkerCandidate()) throw new EngineActionError(400, "没有已验证的 Worker 执行底座。请在设置页扫描并验证一个本机 CLI。 ");
  }

  /**
   * 核对源码声明的 Worker CLI 是否在本机已验证池中。
   *
   * 宿主不预设用户装了某个应用：内置模板与作者模块都可能写死 `cli`，缺失时必须在这里
   * 讲清楚需要哪些 CLI、当前有哪些可用，让用户先验证或改用其他 Workflow；而不是等节点
   * 启动后才以 interrupted 收场。非字面量 options 的调用（`dynamicCount`）无法静态取值，
   * 仍由运行时按 cli fail closed。
   */
  private assertRequiredWorkerClis(
    workers: readonly { readonly cli: import("../runtimes/types").RuntimeCli | null }[],
    pool: readonly { readonly cli: import("../runtimes/types").RuntimeCli }[],
  ): void {
    const required = [...new Set(workers.map((worker) => worker.cli).filter((cli): cli is import("../runtimes/types").RuntimeCli => cli !== null))];
    if (required.length === 0) return;
    const offline = required.filter((cli) => !isCliSelectable(cli)).map((cli) => cliUnavailableReason(cli) ?? `${cli} 已暂时下线。 `);
    if (offline.length > 0) throw new Error(offline.join("；"));
    const available = new Set(pool.map((runtime) => runtime.cli));
    const missing = required.filter((cli) => !available.has(cli));
    if (missing.length === 0) return;
    const installed = [...available];
    throw new Error(`该 Workflow 需要本机已验证的 ${missing.join(" / ")} Worker，但当前没有可用候选${installed.length > 0 ? `（已有：${installed.join(" / ")}）` : ""}；请在设置页扫描并验证对应 CLI，或改用其他 Workflow。 `);
  }

  /** 用户显式选择主控 runtime；有主控回合进行中时拒绝切换，只影响空闲后的新会话。 */
  private async selectCliRuntime(runtimeId: string, value: unknown): Promise<SelectCliRuntimeResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, "选择 CLI Runtime 不接受请求字段。 ");
    try {
      if ((await this.#lead.list()).some(lead => lead.status === "running")) throw new EngineActionError(409, "有主控回合进行中，主控空闲后才能切换。 ");
      return { runtime: await this.#cliRuntimes.select(runtimeId) };
    }
    catch (error) { throw error instanceof EngineActionError ? error : new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  private async deleteCliRuntime(runtimeId: string): Promise<{ readonly deleted: true }> {
    try { await this.#cliRuntimes.remove(runtimeId); return { deleted: true }; }
    catch (error) { throw new EngineActionError(400, error instanceof Error ? error.message : String(error)); }
  }

  private taskPresentation(task:import("../lead/types").LeadSnapshot):import("../lead/types").LeadSnapshot { return {...task,executionAttention:Object.fromEntries(task.executions.filter(execution=>execution.finishedAt===null).map(execution=>[execution.executionId,this.#executions.attention(execution.executionId)]))}; }
  private async leadSnapshot(leadRunId: string): Promise<LeadRunResponse> { const lead=this.taskPresentation(await this.#lead.snapshot(leadRunId));this.#lead.scheduleImpactSummary(leadRunId);return {lead}; }
  private async listLeads(): Promise<LeadRunListResponse> { return { leads: (await this.#lead.list()).map(task=>this.taskPresentation(task)) }; }
  private async sendLeadMessage(leadRunId: string, value: unknown): Promise<LeadRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as LeadMessageRequest).text !== "string") throw new EngineActionError(400, "Lead 消息请求无效。 ");
    const request = value as LeadMessageRequest;
    if (request.clientMessageId !== undefined && typeof request.clientMessageId !== "string") throw new EngineActionError(400, "消息标识必须是字符串 UUID。 ");
    if (request.immediate !== undefined && typeof request.immediate !== "boolean") throw new EngineActionError(400, "立即发送标识无效。 ");
    if (request.stagedAttachmentIds !== undefined && (!Array.isArray(request.stagedAttachmentIds) || request.stagedAttachmentIds.some((item) => typeof item !== "string"))) throw new EngineActionError(400, "附件暂存身份列表无效。 ");
    await this.#lead.submit(leadRunId, request.text, { ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}), ...(request.immediate !== undefined ? { immediate: request.immediate } : {}), ...(request.stagedAttachmentIds?.length ? { stagedAttachmentIds: request.stagedAttachmentIds } : {}) });
    return { lead: await this.#lead.snapshot(leadRunId) };
  }
  private async cancelQueuedLeadMessage(leadRunId: string, value: unknown): Promise<LeadRunResponse> { return { lead: await this.#lead.cancelQueued(leadRunId, requiredString(value, "messageId")) }; }
  private async stageLeadAttachment(value: unknown): Promise<import("../lead/attachments").StagedAttachment> { return this.#lead.stageAttachment(requiredString(value, "path")); }
  private async leadAttachmentData(leadRunId: string, value: unknown): Promise<{ readonly dataUrl: string }> { return this.#lead.attachmentData(leadRunId, requiredString(value, "messageId"), requiredString(value, "attachmentId")); }
  private async abortLead(leadRunId: string, value: unknown): Promise<LeadRunResponse> { if (!isEmptyObject(value)) throw new EngineActionError(400, "Lead abort 不接受请求字段。 "); await this.#lead.abort(leadRunId); return { lead: await this.#lead.snapshot(leadRunId) }; }
  private async acceptWorkflowRevision(leadRunId: string, revision: number, value: unknown): Promise<LeadRunResponse> { if (!isEmptyObject(value)) throw new EngineActionError(400, "接受 Workflow 草案不接受请求字段。 "); return { lead: await this.#lead.acceptWorkflowRevision(leadRunId, revision) }; }
  /** 拒绝最新未接受草案；拒绝是不可逆耐久事实。 */
  private async rejectWorkflowRevision(leadRunId: string, revision: number, value: unknown): Promise<LeadRunResponse> { if (!isEmptyObject(value)) throw new EngineActionError(400, "拒绝 Workflow 草案不接受请求字段。 "); return { lead: await this.#lead.rejectWorkflowRevision(leadRunId, revision) }; }

  /** 创建并后台启动 Execution；编译失败在任何耐久事实之前拒绝。 */
  private async createExecution(leadRunId: string, value: unknown): Promise<ExecutionResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineActionError(400, "创建 Execution 请求无效。 ");
    const { revision, input } = value as CreateExecutionRequest;
    if (!Number.isInteger(revision) || revision < 1) throw new EngineActionError(400, "创建 Execution 必须提供有效 revision 序号。 ");
    if (input !== undefined && !isJsonObject(input)) throw new EngineActionError(400, "Execution input 必须是 JSON-safe 对象。 ");
    try {
      const selected=(await this.#lead.snapshot(leadRunId)).workflowRevisions.find(item=>item.revision===revision);
      if(selected?.templateOrigin){
        validateTemplateInput(selected.templateOrigin.inputSchema,input??{});
        if(canonicalJson(input??{})!==canonicalJson(selected.input))throw new Error("输入与已保存批准版本不一致，请保存新版本后确认。");
      }
      if (!this.deterministicForTest) await this.requireWorkerCandidate();
      if (!selected) throw new Error("创建 Execution 必须绑定当前 revision。");
      const format = selected.sourceFormat ?? (selected.localOrigin ? "module" : "restricted");
      if (format !== "module") throw new Error("旧格式草案不可执行，请重新生成。");
      if (!this.deterministicForTest) {
        // 与规划阶段同一核对：客户端可以跳过 plan 直接创建，这里不能只查“至少有任一 Worker”。
        const extracted = extractAgentWorkers(selected.source);
        const pool = (await this.#cliRuntimes.list()).runtimes.filter((runtime) => runtime.status === "verified");
        this.assertRequiredWorkerClis(extracted.workers, pool);
      }
      const write = hasWorkspaceWriteIntent(readWorkspaceWriteIntent(selected.source));
      const parsed = this.scriptExecutionConfig((value as CreateExecutionRequest).config, write);
      // 逐节点 CLI 是本次执行的事实：解析后写入冻结配置，进入 Journal 生效请求与 Replay 指纹。
      const selection = await this.resolveScriptClis(selected.source, { ...(parsed?.assignmentMode === "script" && parsed.cli !== undefined ? { cli: parsed.cli } : {}), ...(parsed?.assignmentMode === "script" && parsed.nodeClis !== undefined ? { nodeClis: parsed.nodeClis } : {}) });
      const config = this.withCliSelection(parsed, selection);
      const created = await this.#executions.createExecution(leadRunId, revision, input ?? {}, config);
      return { ...created, controllable: this.#executions.isControllable(created.execution.executionId) };
    } catch (error) { throw this.executionError(error); }
  }

  /**
   * 作者模块的执行配置：脚本模式只承载「逐节点 CLI 选择」「动态节点兜底」和（写类）Git 成果授权。
   *
   * 只读模块也可以带 CLI 选择：内置预置不再写死 CLI，由用户在确认页逐节点选择。除此之外的
   * 字段一律拒绝，避免配置悄悄扩张成第二套分配机制。
   */
  private scriptExecutionConfig(raw: unknown, write: boolean): import("../lead/types").ExecutionConfigSnapshot | undefined {
    if (raw === undefined) return undefined;
    const allowed = new Set(["version", "assignmentMode", "createdAt", "cli", "nodeClis", "workspaces"]);
    if (!isJsonObject(raw) || Object.keys(raw).some((key) => !allowed.has(key))) throw new EngineActionError(400, write ? "写类模块 Workflow 只接受 cli/nodeClis 与 workspaces Git 成果授权。" : "只读模块 Workflow 只接受 cli/nodeClis 选择。");
    if (raw.version !== undefined && raw.version !== 1) throw new EngineActionError(400, "执行配置版本无效。");
    if (raw.assignmentMode !== undefined && raw.assignmentMode !== "script") throw new EngineActionError(400, "模块 Workflow 只接受脚本模式配置。");
    if (raw.createdAt !== undefined && (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt)))) throw new EngineActionError(400, "执行配置时间无效。");
    if (raw.cli !== undefined && !isRuntimeCli(raw.cli)) throw new EngineActionError(400, "动态节点兜底 CLI 无效。");
    const nodeClis: Record<string, import("../runtimes/types").RuntimeCli> = {};
    if (raw.nodeClis !== undefined) {
      if (!isJsonObject(raw.nodeClis)) throw new EngineActionError(400, "逐节点 CLI 选择必须是对象。");
      for (const [nodeId, value] of Object.entries(raw.nodeClis)) {
        if (!nodeId.trim() || nodeId.length > 120 || !isRuntimeCli(value)) throw new EngineActionError(400, `逐节点 CLI 选择无效：${nodeId || "(空)"}。`);
        nodeClis[nodeId] = value;
      }
    }
    // 空配置没有语义：既不带 CLI 也不带 Git 授权时必须明确拒绝，而不是静默当作"没有配置"。
    if (raw.cli === undefined && Object.keys(nodeClis).length === 0 && !write) throw new EngineActionError(400, "只读模块 Workflow 的执行配置必须包含逐节点 CLI 选择。");
    if (!write && raw.workspaces !== undefined) throw new EngineActionError(400, "只读模块 Workflow 不接受 Git 成果授权。");
    if (write && !isJsonObject(raw.workspaces)) throw new EngineActionError(400, "写类模块 Workflow 必须提供 workspaces Git 成果授权。");
    const config: import("../lead/types").ExecutionConfigSnapshot = { version: 1, assignmentMode: "script", createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(), ...(raw.cli !== undefined ? { cli: raw.cli } : {}), ...(Object.keys(nodeClis).length > 0 ? { nodeClis } : {}), ...(write ? { workspaces: validateExecutionWorkspaces(raw.workspaces) } : {}) };
    if (!write && config.cli === undefined && config.nodeClis === undefined) return undefined;
    return config;
  }

  /**
   * 解析本次执行的逐节点 CLI 选择。
   *
   * 只影响源码中省略 `cli` 的字面量节点；显式字面量优先，不会被覆盖。每个省略节点各自选择
   * （与主控生成稿逐节点声明 CLI 对齐）；无法静态枚举 id 的动态节点用 `cli` 兜底。只有一个
   * 已验证 CLI 时自动采用它（没有可做的选择），多个时要求用户逐个选择，绝不替用户挑。
   */
  private async resolveScriptClis(
    source: string,
    requested: { readonly cli?: import("../runtimes/types").RuntimeCli; readonly nodeClis?: Readonly<Record<string, import("../runtimes/types").RuntimeCli>> },
  ): Promise<{ readonly cli?: import("../runtimes/types").RuntimeCli; readonly nodeClis?: Readonly<Record<string, import("../runtimes/types").RuntimeCli>> }> {
    const extracted = extractAgentWorkers(source);
    const missing = extracted.workers.filter((worker) => worker.cli === null).map((worker) => worker.id);
    const requestedNodes = requested.nodeClis ?? {};
    const requestedAny = requested.cli !== undefined || Object.keys(requestedNodes).length > 0;
    if (missing.length === 0 && extracted.dynamicCount === 0) {
      if (requestedAny) throw new EngineActionError(400, "该 Workflow 的节点都写明了 CLI，不接受执行级 CLI 选择。");
      return {};
    }
    const unknown = Object.keys(requestedNodes).filter((nodeId) => !missing.includes(nodeId));
    if (unknown.length > 0) throw new EngineActionError(400, `逐节点 CLI 选择包含未省略 cli 的节点：${unknown.join("、")}；这些节点的 CLI 由源码决定。`);
    const pool = (await this.#cliRuntimes.list()).runtimes.filter((runtime) => runtime.status === "verified" && isCliSelectable(runtime.cli));
    const available = [...new Set(pool.map((runtime) => runtime.cli))];
    const ensure = (value: import("../runtimes/types").RuntimeCli, where: string): void => {
      if (!available.includes(value)) throw new EngineActionError(400, `${where}选择的 CLI ${value} 在本机没有已验证候选${available.length > 0 ? `（可用：${available.join(" / ")}）` : ""}；请先在设置页验证，或改选其他 CLI。`);
    };
    if (requested.cli !== undefined) ensure(requested.cli, "动态节点兜底");
    const defaultCli = available.length === 1 ? available[0] : undefined;
    const nodeClis: Record<string, import("../runtimes/types").RuntimeCli> = {};
    const unresolved: string[] = [];
    for (const nodeId of missing) {
      const value = requestedNodes[nodeId] ?? requested.cli ?? defaultCli;
      if (value === undefined) { unresolved.push(nodeId); continue; }
      if (requestedNodes[nodeId] !== undefined) ensure(value, `节点 ${nodeId} `);
      nodeClis[nodeId] = value;
    }
    if (unresolved.length > 0) {
      throw new EngineActionError(400, available.length === 0
        ? "该 Workflow 有节点未声明 CLI，但本机还没有已验证的 CLI；请先在设置页扫描并验证一个。"
        : `以下节点未声明 CLI，请在启动前逐个选择本机已验证的 CLI（可用：${available.join(" / ")}）：${unresolved.join("、")}。`);
    }
    // 动态调用无法逐节点选择：给它们一个明确的兜底 CLI，缺失时拒绝而不是留到运行时才失败。
    const fallback = requested.cli ?? (extracted.dynamicCount > 0 ? defaultCli : undefined);
    if (extracted.dynamicCount > 0 && fallback === undefined) {
      throw new EngineActionError(400, `该 Workflow 有 ${extracted.dynamicCount} 个无法静态枚举的动态节点，请为它们选择一个兜底 CLI${available.length > 0 ? `（可用：${available.join(" / ")}）` : ""}。`);
    }
    return { ...(fallback !== undefined ? { cli: fallback } : {}), ...(Object.keys(nodeClis).length > 0 ? { nodeClis } : {}) };
  }

  /** 把解析后的 CLI 选择并入冻结配置；未产生任何选择时保持原配置。 */
  private withCliSelection(
    parsed: import("../lead/types").ExecutionConfigSnapshot | undefined,
    selection: { readonly cli?: import("../runtimes/types").RuntimeCli; readonly nodeClis?: Readonly<Record<string, import("../runtimes/types").RuntimeCli>> },
  ): import("../lead/types").ExecutionConfigSnapshot | undefined {
    if (selection.cli === undefined && selection.nodeClis === undefined) return parsed;
    const script = parsed?.assignmentMode === "script" ? parsed : undefined;
    return { version: 1, assignmentMode: "script", createdAt: script?.createdAt ?? new Date().toISOString(), ...(selection.cli !== undefined ? { cli: selection.cli } : {}), ...(selection.nodeClis !== undefined ? { nodeClis: selection.nodeClis } : {}), ...(script?.workspaces ? { workspaces: script.workspaces } : {}) };
  }

  /** executions.plan：编译预检冻结源码并枚举 Worker、已验证池与主控 Runtime，供分配卡渲染。 */
  private async planExecution(leadRunId: string, value: unknown): Promise<ExecutionPlanResponse> {
    const revisionNumber = requiredInteger(value, "revision");
    try {
      const snapshot = await this.#lead.snapshot(leadRunId);
      const revision = snapshot.workflowRevisions.find((item) => item.revision === revisionNumber);
      if (snapshot.task) assertStartable(snapshot, revisionNumber, true);
      if (!revision || !snapshot.task && revision.acceptedAt===null) throw new Error("只能为当前候选或已批准历史方案规划执行分配。 ");
      // 编译预检保证分配卡永远不针对不可运行的草案；提取只读 AST，不执行脚本。
      const format=revision.sourceFormat??(revision.localOrigin?"module":"restricted");
      if(format!=="module")throw new Error("旧格式草案不可执行，请重新生成。");
      const inspected = revision.localOrigin?{meta:revision.localOrigin.meta}:inspectWorkflowModuleSource(revision.source,"workflow.ts","生成稿");
      const extracted = extractAgentWorkers(revision.source);
      const list = await this.#cliRuntimes.list();
      const pool = list.runtimes.filter((runtime) => runtime.status === "verified");
      // 不预设用户装了某个 CLI：源码要求的 Worker CLI 若本机没有已验证候选，
      // 必须在规划阶段讲清楚，而不是等节点启动后才以 interrupted 收场。
      this.assertRequiredWorkerClis(extracted.workers, pool);
      // 有节点省略 cli 时，确认页必须逐节点让用户选择；这里只给采集所需事实。
      const missingCliWorkers = extracted.workers.filter((worker) => worker.cli === null);
      const leadRuntimeId=snapshot.runtime?.runtimeId??list.leadRuntimeId;
      const cliChoices = missingCliWorkers.length > 0 || extracted.dynamicCount > 0
        ? (() => {
            const available = [...new Set(pool.filter((runtime) => isCliSelectable(runtime.cli)).map((runtime) => runtime.cli))];
            // 默认预填主控使用的 CLI：Worker 应优先与主控同源，用户再按需逐节点改。
            const leadCli = leadRuntimeId ? pool.find((runtime) => runtime.runtimeId === leadRuntimeId)?.cli : undefined;
            const suggested = leadCli !== undefined && available.includes(leadCli) ? leadCli : available.length === 1 ? available[0]! : null;
            return {
              available,
              suggested,
              nodes: missingCliWorkers.map((worker) => ({ nodeId: worker.id, label: worker.label })),
              dynamicCount: extracted.dynamicCount,
            };
          })()
        : null;
      const intent = readWorkspaceWriteIntent(revision.source);
      let workspacePlan: ExecutionPlanResponse["workspacePlan"] = null;
      if (hasWorkspaceWriteIntent(intent)) {
        workspacePlan = { nodeIds: intent.nodeIds, ...(intent.dynamicNodePrefixes.length?{dynamicNodePrefixes:intent.dynamicNodePrefixes}:{}), repository: snapshot.cwd, baseCommit: null, dirtyPaths: [], diagnostic: intent.uncertain ? "写意图包含无法静态核验的选项或 id，需改为字面量 sandbox 与可披露前缀的 id。" : null };
        if (!intent.uncertain) try { const git = await (await GitRepository.open(snapshot.cwd)).inspect(); workspacePlan = { ...workspacePlan, baseCommit: git.head, dirtyPaths: git.changedPaths }; } catch (error) { workspacePlan = { ...workspacePlan, diagnostic: error instanceof Error ? error.message : String(error) }; }
        // 受管写还依赖系统沙箱执行器；缺失时在规划阶段就标出，禁止用户确认后才在启动期失败。
        if (workspacePlan && workspacePlan.diagnostic === null && !managedWriteBoundaryAvailable()) workspacePlan = { ...workspacePlan, diagnostic: "受管写隔离依赖系统 /usr/bin/sandbox-exec（macOS 自带），但本机不可用；请先用只读 Workflow 或修复系统。" };
      }
      const sceneEvidenceHash=snapshot.task?.workflowContract==="single-workflow-v1"?await this.#lead.currentImpactEvidence(leadRunId):null;
      let continuationPlan:ExecutionPlanResponse["continuationPlan"]=null;
      const prior=[...snapshot.executions].reverse().find(item=>item.config?.workspaces);
      if(workspacePlan&&!intent.uncertain&&snapshot.task?.workflowContract==="single-workflow-v1"&&prior?.config?.workspaces){
        if(!this.singleWorkflowForAcceptance)throw new Error("修订现场续作仅专用验收入口可用。");
        assertCurrentWorkspaceRecord(prior.config.workspaces);
        const frozen=prior.config.workspaces,manager=await WorkspaceManager.open(this.workspaceRoot,this.instanceId),record=await manager.inspect(frozen.workspaceId);
        if(record.leases.length||record.cleanedAt||record.cleanupRequestedAt)throw new Error("原writer未交接或worktree已清理，不能准备新版写入。");
        const scene=await (await GitRepository.open(record.cwd)).inspect();
        if(scene.conflicts.length)throw new Error("原现场存在未解决冲突，请先处理后再准备新版写入。");
        continuationPlan={executionId:prior.executionId,baseCommit:frozen.authorization.baseCommit,workspaceId:frozen.workspaceId,head:scene.head};
        workspacePlan={...workspacePlan,baseCommit:frozen.authorization.baseCommit,dirtyPaths:[],diagnostic:null};
      }
      return { continuationPlan,sceneEvidenceHash, workspacePlan, cliChoices, leadRunId, revision: revisionNumber, phaseTitles: inspected.meta.phases.map((phase) => phase.title), previewAgents: extracted.previewAgents, workers: extracted.workers, dynamicCount: extracted.dynamicCount, pool, selectedByCli: list.selectedByCli, leadRuntime: leadRuntimeId ? pool.find((runtime) => runtime.runtimeId === leadRuntimeId) ?? null : null };
    } catch (error) { throw this.executionError(error); }
  }

  private async listExecutions(leadRunId: string): Promise<ExecutionListResponse> {
    return { leadRunId, executions: await this.#executions.listExecutions(leadRunId) };
  }

  /** Execution 详情：登记事实 + 内嵌 Run 权威快照（含决策门）。 */
  private async executionSnapshot(leadRunId: string, executionId: string): Promise<ExecutionResponse> {
    const execution = (await this.#executions.listExecutions(leadRunId)).find((item) => item.executionId === executionId);
    if (!execution) throw new EngineActionError(404, "未知 WorkflowExecution。 ");
    try {
      const task=await this.#lead.snapshot(leadRunId);
      const revision=task.workflowRevisions.find(item=>item.revision===execution.revision);
      let workspaceEvidence:ExecutionResponse["workspaceEvidence"];
      let workspaceDiagnostic:string|undefined;
      if(execution.config?.workspaces){
        try {
        const manager=await WorkspaceManager.open(this.workspaceRoot,this.instanceId);
        const value=await manager.inspect(execution.config.workspaces.workspaceId);
        const head=value.cleanedAt?null:(await (await GitRepository.open(value.cwd)).inspect()).head;
        workspaceEvidence={workspaceId:value.workspaceId,cwd:value.cwd,branch:value.branch,head,leases:value.leases.filter(lease=>lease.runId===executionId).map(lease=>({nodeId:lease.nodeId,attempt:lease.attempt})),closedWriters:value.closedReleases?.length??0,cleaned:value.cleanedAt!==null};
        } catch(error) { workspaceDiagnostic=`受管工作区现场不可读取：${error instanceof Error?error.message:String(error)}；不代表目录不存在或没有改动。`; }
      }
      return { execution, workspaceEvidence, workspaceDiagnostic, dynamicCount:revision?extractAgentWorkers(revision.source).dynamicCount:undefined, snapshot: await this.#executions.snapshotExecution(leadRunId, executionId), controllable: this.#executions.isControllable(executionId) };
    } catch (error) { throw this.executionError(error); }
  }

  /** Execution 的 Phase 访问分页；attempt 缺省时跨全部 attempt 聚合，供 UI 补齐 replay 复用的 Phase → Agent 关系。 */
  private async executionPhaseVisits(value: unknown): Promise<ExecutionPhaseVisitPageResponse> {
    const leadRunId = requiredString(value, "leadRunId");
    const executionId = requiredString(value, "executionId");
    const attempt = optionalInteger(value, "attempt");
    const cursor = optionalInteger(value, "cursor");
    const options = object(value);
    if (options.includeEmpty !== undefined && typeof options.includeEmpty !== "boolean") throw new EngineActionError(400, "includeEmpty 必须为布尔值。 ");
    try {
      const page = await this.#executions.listExecutionPhaseVisits(leadRunId, executionId, { attempt, cursor, includeEmpty: options.includeEmpty === true });
      return { executionId, executionAttemptId: attempt ?? null, ...page };
    } catch (error) { throw this.executionError(error); }
  }

  private async controlExecution(leadRunId: string, executionId: string, kind: "pause" | "recover" | "stop", value: unknown): Promise<ExecutionResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, `Execution ${kind} 不接受请求字段。 `);
    try {
      const snapshot = kind === "pause" ? await this.#executions.pause(leadRunId, executionId) : kind === "recover" ? await this.#executions.recover(leadRunId, executionId) : await this.#executions.stop(leadRunId, executionId);
      const execution = (await this.#executions.listExecutions(leadRunId)).find((item) => item.executionId === executionId);
      if (!execution) throw new EngineActionError(404, "未知 WorkflowExecution。 ");
      return { execution, snapshot, controllable: this.#executions.isControllable(executionId) };
    } catch (error) { throw this.executionError(error); }
  }

  /** 用户显式恢复中断的 Execution；同一冻结 revision 产生新的 executionAttempt。 */
  private async resumeExecution(leadRunId: string, executionId: string, value: unknown): Promise<ExecutionResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { authorized?: unknown }).authorized !== true) throw new EngineActionError(400, "resume 必须明确携带 authorized: true。 ");
    try {
      const snapshot = await this.#executions.resume(leadRunId, executionId);
      const execution = (await this.#executions.listExecutions(leadRunId)).find((item) => item.executionId === executionId);
      if (!execution) throw new EngineActionError(404, "未知 WorkflowExecution。 ");
      return { execution, snapshot, controllable: this.#executions.isControllable(executionId) };
    } catch (error) { throw this.executionError(error); }
  }

  /** 用户对脚本决策门提交答案；Schema 校验通过并耐久后只唤醒等待中的脚本。 */
  private async answerExecutionGate(leadRunId: string, executionId: string, gateId: string, value: unknown): Promise<ExecutionResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonObject((value as AnswerDecisionRequest).answer)) throw new EngineActionError(400, "决策门答案必须是 JSON 对象。 ");
    try {
      const snapshot = await this.#executions.answerGate(leadRunId, executionId, gateId, (value as AnswerDecisionRequest).answer);
      const execution = (await this.#executions.listExecutions(leadRunId)).find((item) => item.executionId === executionId);
      if (!execution) throw new EngineActionError(404, "未知 WorkflowExecution。 ");
      return { execution, snapshot, controllable: this.#executions.isControllable(executionId) };
    } catch (error) { throw this.executionError(error); }
  }

  /** 用户回答主控 request_user_decision；答案只唤醒原工具调用。 */
  private async answerLeadDecision(leadRunId: string, decisionId: string, value: unknown): Promise<LeadRunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonObject((value as AnswerDecisionRequest).answer)) throw new EngineActionError(400, "决策答案必须是 JSON 对象。 ");
    try {
      return { lead: await this.#lead.answerUserDecision(leadRunId, decisionId, (value as AnswerDecisionRequest).answer) };
    } catch (error) { throw this.executionError(error); }
  }


  /** Execution 服务错误归一化；控制冲突与未知身份保留稳定诊断。 */
  private executionError(error: unknown): EngineActionError {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof EngineActionError) return error;
    if (message.includes("未结束") || message.includes("可控制生命周期") || message.includes("不能同时执行") || message.includes("已在当前 Engine 运行") || message.includes("已回答") || message.includes("可以 pause") || message.includes("可以 recover")) return new EngineActionError(409, message);
    if (message.includes("未知")) return new EngineActionError(404, message);
    return new EngineActionError(400, message);
  }

  /** 菜单栏只能读取这个摘要，不得维护自己的 Run 状态机。 */
  async status(): Promise<DesktopStatusResponse> {
    const runs = await this.listRuns(); const leads = await this.listLeads();
    return {
      protocolVersion: 1,
      activeRuns: runs.filter(run => isLiveRunStatus(run.status)).length,
      blockedRuns: runs.filter(run => run.hasBlockedAgent).length,
      activeLeads: leads.leads.filter(lead => lead.status === "running").length,
      acpWorkersNeedingResume: this.#acpWorkersNeedingResume,
    };
  }

  /**
   * Desktop 私有 action 入口。
   *
   * Tauri 只传递动作名与 JSON 参数，Engine 直接调用业务方法；这里不接收 URL、
   * HTTP method、Request 或 Response。
   */
  async handleDesktopAction(action: string, args: unknown = {}): Promise<unknown> {
    // 退出事实一旦开始耐久，绝不能允许随后排队的 UI action 创建新 Run、恢复旧
    // Worker 或交付答案。status 是只读诊断，保留它便于 Tauri/测试观察收敛。
    if (this.#exitRequested && action !== "status") throw new Error("Desktop 正在退出，拒绝新的控制动作。 ");
    const value = args ?? {};
    switch (action) {
      case "status": return this.status();
      case "runs.list": return this.listRuns();
      case "runs.create": return this.createRun(value);
      case "runs.inspect": return this.inspect(requiredString(value, "runId"));
      case "runs.currentAttempt": return this.currentAttempt(requiredString(value, "runId"));
      case "runs.executionAttempts": return this.executionAttempts(requiredString(value, "runId"));
      case "runs.phaseVisit": return this.phaseVisit(requiredString(value, "runId"), requiredInteger(value, "phaseVisitId"), optionalInteger(value, "attempt"));
      case "runs.phaseVisits": return this.desktopPhaseVisits(value);
      case "runs.pause": return this.pause(requiredString(value, "runId"), {});
      case "runs.recover": return this.recover(requiredString(value, "runId"), {});
      case "runs.stop": return this.stopRun(requiredString(value, "runId"), {});
      case "runs.resume": return this.resume(requiredString(value, "runId"), { authorized: true });
      case "blocks.answer": return this.desktopAnswerBlock(value);
      case "runtimes.list": return this.listCliRuntimes();
      case "runtimes.discover": return this.discoverCliRuntimes({});
      case "runtimes.scan": return this.scanCliRuntimes({});
      case "runtimes.validate": return this.validateCliRuntime(value);
      case "runtimes.select": return this.selectCliRuntime(requiredString(value, "runtimeId"), {});
      case "runtimes.delete": return this.deleteCliRuntime(requiredString(value, "runtimeId"));
      case "skills.status": return this.skillStatus();
      case "skills.discover": return this.discoverSkills();
      case "skills.import": return this.importSkill(value);
      case "skills.importZip": return this.importSkillArchive(value);
      case "skills.open": return this.openSkillLibrary();
      case "projects.list": return this.listProjects();
      case "projects.context": return readProjectContext((await this.#projects.get(requiredString(value, "projectId"))).cwd);
      case "projects.create": return this.createProject(value);
      case "projects.validatePath": return { cwd: await validateProjectDirectory(requiredString(value, "cwd")) };
      case "templates.list": return {templates:listWorkflowTemplates()};
      case "templates.save": {
        const request=object(value);
        if(!isTemplateSelection(request.template))throw new Error("模板选择字段无效。");
        if(request.cardId!==undefined&&(!Number.isInteger(request.baseRevision)||Number(request.baseRevision)<1))throw new Error("编辑参数必须绑定基础版本。");
        return {lead:await this.#lead.prepareTemplate(requiredString(value,"leadRunId"),requiredString(value,"clientRequestId"),request.template,typeof request.cardId==="string"?request.cardId:undefined,request.baseRevision as number|undefined)};
      }
      case "templates.confirm": return this.confirmTemplate(requiredString(value,"leadRunId"),value);
      case "executions.confirm": return this.confirmTemplate(requiredString(value,"leadRunId"),value,false);
      case "leads.list": return this.listLeads();
      case "leads.create": return this.createLead(value);
      case "leads.startConversation": return this.startLeadConversation(requiredString(value, "projectId"), value);
      case "leads.get": return this.leadSnapshot(requiredString(value, "leadRunId"));
      case "leads.commandCatalog": return this.leadCommandCatalog(value);
      case "leads.renameTitle": return {lead:await this.#lead.renameTitle(requiredString(value,"leadRunId"),requiredString(value,"title"))};
      case "leads.send": return this.sendLeadMessage(requiredString(value, "leadRunId"), value);
      case "leads.cancelQueued": return this.cancelQueuedLeadMessage(requiredString(value, "leadRunId"), value);
      case "leads.stageAttachment": return this.stageLeadAttachment(value);
      case "leads.attachmentData": return this.leadAttachmentData(requiredString(value, "leadRunId"), value);
      case "leads.retryImpactSummary": return {lead:await this.#lead.retryImpactSummary(requiredString(value,"leadRunId"),requiredString(value,"key"))};
      case "leads.stopImpactSummary": return {lead:await this.#lead.stopImpactSummary(requiredString(value,"leadRunId"),requiredString(value,"key"),requiredString(value,"turnId"))};
      case "leads.recoverController": return {lead:await this.#lead.recoverController(requiredString(value,"leadRunId"))};
      case "executions.capsule": return this.#lead.executionCapsule(requiredString(value,"leadRunId"),requiredString(value,"executionId"),requiredInteger(value,"attempt"));
      case "executions.checkScene": {
        const taskId=requiredString(value,"leadRunId"), executionId=requiredString(value,"executionId");
        try { await this.#lead.ensureCurrentImpact(taskId,executionId); }
        catch (error) {
          if (!(error instanceof ImpactSupplementRequiredError)) throw error;
          // 变化已耐久建立pending补充，检查动作返回待办，不谎报启动成功。
        }
        return {lead:await this.#lead.snapshot(taskId)};
      }
      case "leads.abort": return this.abortLead(requiredString(value, "leadRunId"), {});
      case "leads.complete": {const request=value as Record<string,unknown>;if(request.abandonImpactSummaries!==undefined&&typeof request.abandonImpactSummaries!=="boolean")throw new Error("归档放弃标识无效。");return {lead:await this.#lead.complete(requiredString(value,"leadRunId"),request.abandonImpactSummaries===true)};}
      case "leads.retryInitialization": return { lead: await this.#lead.retryInitialization(requiredString(value, "leadRunId")) };
      case "leads.abandonCard": return { lead: await this.#lead.abandonWorkflowCard(requiredString(value, "leadRunId"), requiredString(value, "cardId")) };
      case "leads.acceptRevision": return this.acceptWorkflowRevision(requiredString(value, "leadRunId"), requiredInteger(value, "revision"), {});
      case "leads.rejectRevision": return this.rejectWorkflowRevision(requiredString(value, "leadRunId"), requiredInteger(value, "revision"), {});
      case "leads.answerDecision": return this.answerLeadDecision(requiredString(value, "leadRunId"), requiredString(value, "decisionId"), value);
      case "executions.create": return this.createExecution(requiredString(value, "leadRunId"), value);
      case "executions.plan": return this.planExecution(requiredString(value, "leadRunId"), value);
      case "executions.list": return this.listExecutions(requiredString(value, "leadRunId"));
      case "executions.get": return this.executionSnapshot(requiredString(value, "leadRunId"), requiredString(value, "executionId"));
      case "executions.savePartial": {
        if(object(value).authorized!==true)throw new Error("保存停止现场必须由用户明确授权。");
        const taskId=requiredString(value,"leadRunId"),executionId=requiredString(value,"executionId");
        const task=await this.#lead.snapshot(taskId);
        if(task.status==="completed"||!task.executions.some(item=>item.executionId===executionId))throw new Error("执行不属于当前未归档任务。");
        const detail=await this.executionSnapshot(taskId,executionId);
        if(detail.snapshot.status!=="cancelled"&&detail.snapshot.status!=="interrupted")throw new Error("只有停止/中断后的执行可以显式保存现场。");
        const executor=this.#workspaceExecutors.get(executionId);
        if(!executor)throw new Error("本Engine没有原writer可核验句柄；重启后需人工核查现场，不能按旧PID保存或交接。");
        for(const node of detail.snapshot.phases.flatMap(phase=>phase.agents))if(node.status==="cancelled"||node.status==="interrupted")await executor.finalizePartial(node);
        return this.executionSnapshot(taskId,executionId);
      }
      // 受管checkout清理动作：用户明确授权后删除身份一致、无租约且未命中删除防护的受管checkout。
      // 宿主不保存成果快照，未提交内容随目录删除，由用户负责。当前没有 Web 入口，只能由 Engine 动作显式触发。
      case "executions.cleanupWorkspaces": {
        if(object(value).authorized!==true)throw new Error("清理受管checkout必须由用户明确授权。");
        const taskId=requiredString(value,"leadRunId"),executionId=requiredString(value,"executionId"),task=await this.#lead.snapshot(taskId);
        const execution=task.executions.find(item=>item.executionId===executionId);
        if(task.status==="completed"||!execution?.config?.workspaces)throw new Error("只能清理当前未归档任务的受管workspace。");
        if(execution.finishedAt===null)throw new Error("执行尚未终态，禁止清理。");
        assertCurrentWorkspaceRecord(execution.config.workspaces);
        const manager=await WorkspaceManager.open(this.workspaceRoot,this.instanceId);
        await manager.cleanup(execution.config.workspaces.workspaceId,true);
        return this.executionSnapshot(taskId,executionId);
      }
      case "executions.attemptResults": return this.#executions.attemptResults(requiredString(value,"leadRunId"),requiredString(value,"executionId"),requiredInteger(value,"attempt"));
      case "executions.phaseVisits": return this.executionPhaseVisits(value);
      case "executions.control": return this.controlExecution(requiredString(value, "leadRunId"), requiredString(value, "executionId"), requiredExecutionControl(value), {});
      case "executions.resume": return this.resumeExecution(requiredString(value, "leadRunId"), requiredString(value, "executionId"), { authorized: true });
      case "workflows.preflightLocal": {
        if(!this.singleWorkflowForAcceptance)throw new Error("本地预检仅专用验收构建可用。");
        const project = await this.#projects.get(requiredString(value, "projectId"));
        const result = await preflightLocalWorkflow(requiredString(value, "path"), project.cwd);
        // 源码只保留在Engine，不向普通预检界面返回第二份可提交源码。
        const { source, ...preview } = result;
        return preview;
      }
      case "workflows.saveAndAdoptRevision": {
        const input=object(value).input;
        if(input!==undefined&&!isJsonObject(input))throw new Error("保存并接管的输入必须是 JSON 对象。");
        const replace=object(value).replace;
        if(replace!==undefined&&typeof replace!=="boolean")throw new Error("保存并接管的替换标记必须是布尔值。");
        return {lead:await this.#lead.saveAndAdoptRevision(requiredString(value,"leadRunId"),{clientRequestId:requiredString(value,"clientRequestId"),revision:requiredInteger(value,"revision"),path:requiredString(value,"path"),...(input===undefined?{}:{input}),...(replace===true?{replace:true}:{})})};
      }
      case "workflows.createLocalTask": {
        const project=await this.#projects.get(requiredString(value,"projectId"));
        const input=object(value).input;
        if(!isJsonObject(input))throw new Error("本地参数必须是JSON对象。");
        return {lead:await this.#lead.startLocalTask(project.cwd,{projectId:project.projectId,clientRequestId:requiredString(value,"clientRequestId"),path:requiredString(value,"path"),sourceHash:requiredString(value,"sourceHash"),input,title:typeof object(value).title==="string"?String(object(value).title):undefined})};
      }
      case "workflows.reviseLocalTask": {
        if(!this.singleWorkflowForAcceptance)throw new Error("本地修订仅专用验收构建可用。");
        const input=object(value).input;if(!isJsonObject(input))throw new Error("本地参数必须是JSON对象。");
        const updateReason=object(value).updateReason;
        if(updateReason!==undefined&&updateReason!=="save-local"&&updateReason!=="modify-plan"&&updateReason!=="modify-parameters")throw new Error("本地修订的更新原因无效。");
        return {lead:await this.#lead.reviseLocalTask(requiredString(value,"leadRunId"),{clientRequestId:requiredString(value,"clientRequestId"),baseRevision:requiredInteger(value,"baseRevision"),sourceHash:requiredString(value,"sourceHash"),input,...(object(value).path===undefined?{}:{path:requiredString(value,"path")}),...(updateReason===undefined?{}:{updateReason})})};
      }
      case "executions.answerGate": return this.answerExecutionGate(requiredString(value, "leadRunId"), requiredString(value, "executionId"), requiredString(value, "gateId"), value);
      default: throw new Error(`未知 Desktop action：${action}。`);
    }
  }

  /** 模板最终确认：同一生命周期短事务复核资格/输入/配置，再批准、登记和派发。 */
  private async confirmTemplate(id:string,value:unknown,templateOnly=true):Promise<ExecutionResponse>{
    if(Object.keys(object(value)).some(key=>!["leadRunId","revision","config","clientRequestId","input","sceneEvidenceHash"].includes(key)))throw new Error("模板确认不接受额外字段。");
    const confirmedScene=object(value).sceneEvidenceHash;
    if(confirmedScene!==undefined&&confirmedScene!==null&&(typeof confirmedScene!=="string"||! /^[a-f0-9]{64}$/.test(confirmedScene)))throw new Error("确认现场证据版本无效。");
    const requestId=requiredString(value,"clientRequestId");
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))throw new Error("确认请求必须是 UUID。");
    return this.#lead.lifecycle.run(id,async()=>{
      const number=requiredInteger(value,"revision"),snapshot=await this.#lead.snapshot(id);
      const revision=snapshot.workflowRevisions.find(item=>item.revision===number);
      if(!revision||templateOnly&&!revision.templateOrigin)throw new Error("仅当前候选可确认并运行。");
      if(revision.localOrigin)validateLocalInput(revision.localOrigin.inputSchema,object(value).input??revision.input??{});
      const input=object(value).input??revision.input??{};
      if(!isJsonObject(input))throw new Error("工作流参数必须是JSON-safe对象。");
      const rawConfig=object(value).config;
      const format=revision.sourceFormat??(revision.localOrigin?"module":"restricted");
      if(format!=="module")throw new Error("旧格式草案不可执行，请重新生成。");
      const write=hasWorkspaceWriteIntent(readWorkspaceWriteIntent(revision.source));
      const parsedConfig=this.scriptExecutionConfig(rawConfig,write);
      // 逐节点 CLI 选择在哈希之前解析：它属于本次执行事实，同请求重试必须得到同一份配置。
      const selection=await this.resolveScriptClis(revision.source,{...(parsedConfig?.assignmentMode==="script"&&parsedConfig.cli!==undefined?{cli:parsedConfig.cli}:{}),...(parsedConfig?.assignmentMode==="script"&&parsedConfig.nodeClis!==undefined?{nodeClis:parsedConfig.nodeClis}:{})});
      const resolvedConfig=this.withCliSelection(parsedConfig,selection);
      const payloadHash=createHash("sha256").update(canonicalJson({revision:number,input,config:resolvedConfig??null,...(confirmedScene?{sceneEvidenceHash:confirmedScene}:{})})).digest("hex");
      const receipt=snapshot.executionConfirmations?.find(item=>item.requestId===requestId);
      if(receipt&&(receipt.payloadHash!==payloadHash||receipt.revision!==number))throw new Error("相同确认请求不能更换版本、输入或配置。");
      const previous=snapshot.executions.find(item=>item.confirmationRequestId===requestId);
      if(previous){
        if(previous.confirmationPayloadHash!==payloadHash)throw new Error("相同确认请求不能更换版本、输入或配置。");
        return this.executionSnapshot(id,previous.executionId);
      }
      if(snapshot.task?.workflowContract==="single-workflow-v1"&&snapshot.executions.length&&!this.singleWorkflowForAcceptance)throw new Error("修订现场续作仅专用验收入口可用，尚未正式开放。");
      if(snapshot.task?.workflowContract==="single-workflow-v1"&&snapshot.executions.length){
        const current=await this.#lead.currentImpactEvidence(id);
        if(!confirmedScene||confirmedScene!==current)throw new Error("确认时的现场证据已变化，请重新检查并确认；不启动新版工作。");
      }
      // 若上次确认已耐久参数新版本、却在登记执行前失败，同请求只能继续那个
      // 已保存版本；不能把任意旧revision重新变为可启动。
      const preparedRetry=snapshot.workflowRevisions.find(item=>item.saveRequestId===requestId);
      const candidateNumber=preparedRetry?.parentRevision===number?preparedRetry.revision:number;
      assertStartable(snapshot,candidateNumber,true);
      if(revision.templateOrigin)validateTemplateInput(revision.templateOrigin.inputSchema,input);
      else if(revision.localOrigin){if(canonicalJson(input)!==canonicalJson(revision.input??{}))throw new Error("本地输入与已预检版本不一致，请重新预检。");}
      else validateLocalInput(inspectWorkflowModuleSource(revision.source,"workflow.ts","生成稿").inputSchema,input);
      if(!this.deterministicForTest)await this.requireWorkerCandidate();
      const config=resolvedConfig;
      if(!receipt)await this.#lead.prepareExecutionConfirmation(id,{requestId,revision:number,payloadHash});
      let selected=preparedRetry?.parentRevision===number?preparedRetry:revision;
      if(revision.templateOrigin&&(revision.parametersPending||canonicalJson(input)!==canonicalJson(revision.input))){
        const origin=revision.templateOrigin;
        const prepared=await this.#lead.saveTemplate(id,requestId,{id:origin.id,version:origin.version,sourceHash:origin.sourceHash,input},revision.cardId);
        selected=prepared.workflowRevisions.find(item=>item.saveRequestId===requestId)!;
      }
      if(selected.acceptedAt===null)await this.#lead.acceptWorkflowRevision(id,selected.revision);
      const created=await this.#executions.createExecution(id,selected.revision,input,config,{confirmationRequestId:requestId,confirmationPayloadHash:payloadHash,...(confirmedScene?{sceneEvidenceHash:confirmedScene as string}:{})});
      return {...created,controllable:this.#executions.isControllable(created.execution.executionId)};
    });
  }

  private async desktopPhaseVisits(value: unknown): Promise<PhaseVisitPageResponse> {
    const runId = requiredString(value, "runId");
    const options = object(value);
    const attempt = optionalInteger(value, "attempt");
    const runtime = await this.readRuntime(runId);
    const executionAttemptId = attempt ?? runtime.snapshot().currentExecutionAttemptId;
    if (!runtime.state.hasExecutionAttempt(executionAttemptId)) throw new EngineActionError(404, "指定执行尝试不存在。 ");
    const cursor = optionalInteger(value, "cursor");
    const includeEmpty = options.includeEmpty === true;
    if (options.includeEmpty !== undefined && typeof options.includeEmpty !== "boolean") throw new EngineActionError(400, "includeEmpty 必须为布尔值。 ");
    return { runId, executionAttemptId, ...runtime.state.listPhaseVisits(executionAttemptId, cursor, 20, includeEmpty) };
  }

  private async desktopAnswerBlock(value: unknown): Promise<{ readonly ok: true }> {
    const blockRequestId = requiredString(value, "blockRequestId");
    const answer = object(value).answer;
    if (!isJsonObject(answer)) throw new EngineActionError(400, "block 答案必须是 JSON 对象。 ");
    const control = [...this.#controls.values()].find(candidate => candidate.hasBlock(blockRequestId));
    if (!control) throw new EngineActionError(404, "指定 block 不属于当前 Engine。 ");
    await control.answer({ blockRequestId, answer });
    return { ok: true };
  }

  private async createRun(value: unknown): Promise<RunResponse> {
    if (!isCreateRunRequest(value)) throw new EngineActionError(400, "创建 Run 请求无效。");
    const inFlight = this.#createRequests.get(value.clientRequestId);
    if (inFlight) return inFlight;
    // 必须在任何 await 前登记：两个并发 POST 若都先完成磁盘查找，会各自创建一个 Run。
    const task = (async () => {
      // 第一条请求已经返回后，客户端仍可能因响应丢失而带着同一个
      // clientRequestId 重试。这时 Run 已在本 Engine 内存中运行，不能再从
      // Journal 以“无法恢复运行中 Run”为由拒绝它；直接返回同一份权威快照。
      const active = [...this.#runs.values()].find((runtime) => runtime.journal.manifest.clientRequestId === value.clientRequestId);
      if (active) return { runId: active.snapshot().id, snapshot: active.snapshot() };
      const durable = await this.findByClientRequestId(value.clientRequestId);
      if (!durable && [...this.#runs.values()].filter((runtime) => isLiveRunStatus(runtime.snapshot().status)).length >= this.maxActiveRuns) throw new EngineActionError(429, `全局运行中 Run 已达到上限：${this.maxActiveRuns}。`);
      return durable ?? this.createRunOnce(value);
    })().finally(() => this.#createRequests.delete(value.clientRequestId));
    this.#createRequests.set(value.clientRequestId, task);
    return task;
  }

  /** Run 总览：当前 Engine 内存中的 Run 为权威；不接管其他进程的活跃任务。 */
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
    return item;
  }

  private async executionAttempts(runId: string): Promise<ExecutionAttemptsResponse> {
    const runtime = await this.readRuntime(runId);
    const currentExecutionAttemptId = runtime.snapshot().currentExecutionAttemptId;
    return { runId, currentExecutionAttemptId, executionAttemptIds: runtime.state.executionAttemptIds() };
  }

  /** 返回一轮完整批次 / Agent；默认只允许当前尝试。 */
  private async phaseVisit(runId: string, phaseVisitId: number, attempt: number | null): Promise<PhaseVisitResponse> {
    if (!isPositiveInteger(phaseVisitId)) throw new EngineActionError(400, "phaseVisitId 无效。 ");
    const runtime = await this.readRuntime(runId);
    const executionAttemptId = attempt ?? runtime.snapshot().currentExecutionAttemptId;
    if (!runtime.state.hasExecutionAttempt(executionAttemptId)) throw new EngineActionError(404, "指定执行尝试不存在。 ");
    const visit = runtime.state.phaseVisitDetail(phaseVisitId, executionAttemptId);
    if (!visit) throw new EngineActionError(404, "指定阶段轮次不存在。 ");
    return { runId, executionAttemptId, visit };
  }

  private async readRuntime(runId: string): Promise<RunRuntime> {
    try { validateRunId(runId); } catch { throw new EngineActionError(400, "RunId 无效。 "); }
    return this.#runs.get(runId) ?? RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
  }

  private async createRunOnce(value: CreateRunRequest): Promise<RunResponse> {
    const cwd = await realpath(value.cwd);
    const workflow = await loadWorkflow(value.workflowPath, cwd);
    const sourcePath = await realpath(resolve(cwd, value.workflowPath));
    const source = await Bun.file(sourcePath).text();
    if (!this.deterministicForTest) await this.requireWorkerCandidate();
    const baseExecutor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : new RuntimeAcpWorkerExecutor(this.#cliRuntimes, (identity, scratch) => this.workerControlMcp(identity, scratch), undefined, null, join(dirname(this.storeRoot), "read-only-scratch"), this.skillsRoot);
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
    if (this.#exitRequested) {
      await runtime.cancelForDesktopExit(this.instanceId);
      this.#controls.delete(runId);
      return { runId, snapshot: runtime.snapshot() };
    }
    const task = runtime.run(workflow).catch(() => undefined).finally(() => { this.#runTasks.delete(runId); });
    this.#runTasks.set(runId, task);
    await runtime.waitForSafeLaunch();
    return { runId: runtime.snapshot().id, snapshot: runtime.snapshot() };
  }

  /** 用户显式授权的调用级恢复；严格核验 Manifest 源码与项目边界后才重放。 */
  private async resume(runId: string, value: unknown): Promise<RunResponse> {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as ResumeRunRequest).authorized !== true) throw new EngineActionError(400, "resume 必须明确携带 authorized: true。 ");
    const linked=await RunJournal.open(runId,this.storeRoot);
    if(linked.journal.manifest.lead)throw new EngineActionError(409,"此Run归属Task，请通过所属工作流恢复，不能使用独立Run入口。");
    const inFlight = this.#resumeRequests.get(runId);
    if (inFlight) return inFlight;
    // 必须在任一 await 前登记：两个 POST 若都先读取到没有 runTask，就会各自启动
    // 新 attempt，突破“一个 Run 同时只允许一条重放”的副作用边界。
    const task = this.resumeOnce(runId).finally(() => this.#resumeRequests.delete(runId));
    this.#resumeRequests.set(runId, task);
    return task;
  }

  /** 只允许当前 Engine 持有的真实 Run 暂停；离线 Journal 不可伪造暂停。 */
  private async pause(runId: string, value: unknown): Promise<RunResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, "pause 不接受请求字段。 ");
    return this.runControl(runId, "pause", async (runtime) => {
      if (runtime.snapshot().status !== "running") throw new EngineActionError(409, "只有 running 的 Run 可以 pause。 ");
      const snapshot = await runtime.pause();
      return { runId, snapshot };
    });
  }

  /** recover 只能针对当前 Engine 保留的 paused 会话，拒绝离线或历史 Run。 */
  private async recover(runId: string, value: unknown): Promise<RunResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, "recover 不接受请求字段。 ");
    return this.runControl(runId, "recover", async (runtime) => {
      if (runtime.snapshot().status !== "paused") throw new EngineActionError(409, "只有 paused 的 Run 可以 recover。 ");
      const snapshot = await runtime.recover();
      return { runId, snapshot };
    });
  }

  private async stopRun(runId: string, value: unknown): Promise<RunResponse> {
    if (!isEmptyObject(value)) throw new EngineActionError(400, "stop 不接受请求字段。 ");
    const active = this.#runControlRequests.get(runId);
    if (active && active.kind !== "stop") {
      const runtime = this.#runs.get(runId);
      if (!runtime) throw new EngineActionError(409, "该 Run 不在当前 Engine 的可控制生命周期内。 ");
      // stop 优先于 pause/recover：先取消正在等待的 ACP 控制调用，待其清理完
      // 控制锁后再执行真正终止，避免两个操作同时改写同一状态机。
      runtime.requestStop();
      await active.promise.catch(() => undefined);
    }
    return this.runControl(runId, "stop", async (runtime) => ({ runId, snapshot: await runtime.stop() }));
  }

  private async runControl(runId: string, kind: "pause" | "recover" | "stop", operation: (runtime: RunRuntime) => Promise<RunResponse>): Promise<RunResponse> {
    try { validateRunId(runId); } catch { throw new EngineActionError(400, "RunId 无效。 "); }
    const active = this.#runControlRequests.get(runId);
    if (active) {
      if (active.kind === kind) return active.promise;
      throw new EngineActionError(409, `该 Run 正在执行 ${active.kind}，不能同时执行 ${kind}。`);
    }
    const task = (async () => {
      const runtime = this.#runs.get(runId);
      if (!runtime || !this.#runTasks.has(runId)) throw new EngineActionError(409, "该 Run 不在当前 Engine 的可控制生命周期内。 ");
      return operation(runtime);
    })().finally(() => this.#runControlRequests.delete(runId));
    this.#runControlRequests.set(runId, { kind, promise: task });
    return task;
  }

  private async resumeOnce(runId: string): Promise<RunResponse> {
    if (this.#runTasks.has(runId)) throw new EngineActionError(409, "该 Run 仍由当前 Engine 执行，不能重复 resume。 ");
    const opened = await RunJournal.open(runId, this.storeRoot);
    if (!this.deterministicForTest) await this.requireWorkerCandidate();
    const manifest = opened.journal.manifest;
    if (manifest.runtimeVersion !== RUNTIME_VERSION) throw new EngineActionError(409, `resume 仅支持当前 Runtime v${RUNTIME_VERSION} 的 Run；历史 v${manifest.runtimeVersion} 只能读取。`);
    let source: string;
    try { source = await Bun.file(manifest.workflowPath).text(); } catch { throw new EngineActionError(409, "resume 的 Workflow 源码不可读取。 "); }
    if (createHash("sha256").update(source).digest("hex") !== manifest.workflowHash) throw new EngineActionError(409, "resume 拒绝：Workflow 源码 hash 已变化。 ");
    const cwd = await realpath(manifest.workflowProjectCwd).catch(() => { throw new EngineActionError(409, "resume 的 Workflow 项目目录不可验证。 "); });
    if (cwd !== manifest.workflowProjectCwd) throw new EngineActionError(409, "resume 拒绝：Workflow 项目目录已变化。 ");
    const workflow = await loadWorkflow(manifest.workflowPath, cwd);
    const baseExecutor: AgentNodeExecutor = this.deterministicForTest
      ? new DeterministicExecutor()
      : new RuntimeAcpWorkerExecutor(this.#cliRuntimes, (identity, scratch) => this.workerControlMcp(identity, scratch), undefined, null, join(dirname(this.storeRoot), "read-only-scratch"), this.skillsRoot);
    const executor = new LimitedAgentExecutor(baseExecutor, this.agentStartLimiter);
    const runtime = await RunRuntime.resume(runId, executor, this.storeRoot, null, this.skillsRoot);
    const blocked = runtime.snapshot().phases.flatMap(phase => phase.agents).find(node => !isCliSelectable(node.cli));
    if (blocked) throw new EngineActionError(409, `无法恢复：节点 ${blocked.id} 使用 ${blocked.cli}，该 CLI 支持已暂时下线。请新建使用其他 CLI 的执行。 `);
    await this.reconcileResumeSessions(runtime);
    if (!this.deterministicForTest && isControlBoundExecutor(baseExecutor)) {
      const control = runtime.createControlServer();
      baseExecutor.bindControl(control);
      this.registerControlForResume(runId, control, runtime);
    }
    this.#runs.set(runId, runtime);
    if (this.#exitRequested) {
      await runtime.cancelForDesktopExit(this.instanceId);
      this.#controls.delete(runId);
      return { runId, snapshot: runtime.snapshot() };
    }
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

  /** resume 可能替换旧 Engine 的内存 Runtime，允许首次注册但拒绝重复 Control。 */
  private registerControlForResume(runId: string, control: ControlServer, runtime: RunRuntime): void {
    if (this.#controls.has(runId)) throw new EngineActionError(409, "该 Run 已有 ControlServer，不能重复 resume。 ");
    if (runtime.journal.manifest.runId !== runId) throw new EngineActionError(400, "resume Run 身份不一致。 ");
    this.#controls.set(runId, control);
  }

  /** 用户显式 resume 前将旧 active ACP 节点耐久收敛为 interrupted。 */
  private async reconcileResumeSessions(runtime: RunRuntime): Promise<void> {
    const unverifiable: import("../runtime/run-types").AgentNodeSnapshot[] = [];
    for (const node of runtime.snapshot().phases.flatMap((phase) => phase.agents)) {
      if ((node.status !== "running" && node.status !== "blocked") || !node.agentSessionId) continue;
      unverifiable.push(node);
    }
    // 所有旧会话均已确认不可验证后，才写 interrupted。避免一个并行节点仍存活时，
    // 已遍历到的其他节点被部分修改，随后 resume 又整体被拒绝。
    for (const node of unverifiable) {
      const event: import("../journal/types").JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: runtime.snapshot().id, nodeId: node.id, agentSessionId: node.agentSessionId, diagnostic: "用户显式 resume 时不认领旧 ACP 会话。", status: "interrupted" };
      await runtime.commitConvergence(event);
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
        if (isLiveRunStatus(runtime.snapshot().status)) throw new EngineActionError(409, "相同创建请求的 Run 仍在受管生命周期内，但当前 Engine 未持有其权威状态；请重新打开 Wave Flow。");
        this.#runs.set(runId, runtime);
        return { runId, snapshot: runtime.snapshot() };
      } catch (error) {
        if (error instanceof EngineActionError) throw error;
      }
    }
    return null;
  }


  private async inspect(runId: string): Promise<RunResponse> {
    const memory = this.#runs.get(runId);
    if (memory) return { runId, snapshot: memory.snapshot() };
    const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), this.storeRoot);
    if (isLiveRunStatus(runtime.snapshot().status)) throw new EngineActionError(409, "Run 仍在受管生命周期内，但当前 Engine 未持有其权威状态；请重新打开 Wave Flow。");
    this.#runs.set(runId, runtime);
    return { runId, snapshot: runtime.snapshot() };
  }

}


function isControlBoundExecutor(value: AgentNodeExecutor): value is ControlBoundExecutor {
  return typeof (value as Partial<ControlBoundExecutor>).bindControl === "function";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineActionError(400, "Desktop action 参数必须是对象。 ");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, key: string): string {
  const field = object(value)[key];
  if (typeof field !== "string" || !field.trim()) throw new EngineActionError(400, `Desktop action 缺少 ${key}。`);
  return field;
}
function requiredInteger(value: unknown, key: string): number {
  const field = object(value)[key];
  if (!Number.isInteger(field)) throw new EngineActionError(400, `Desktop action 的 ${key} 必须是整数。`);
  return field as number;
}
function optionalInteger(value: unknown, key: string): number | null {
  const field = object(value)[key];
  if (field === undefined || field === null) return null;
  if (!Number.isInteger(field)) throw new EngineActionError(400, `Desktop action 的 ${key} 必须是整数。`);
  return field as number;
}
function requiredExecutionControl(value: unknown): "pause" | "recover" | "stop" {
  const field = object(value).action;
  if (field === "pause" || field === "recover" || field === "stop") return field;
  throw new EngineActionError(400, "Desktop action 的 Execution 控制动作无效。 ");
}

/**
 * 只读取已结束 Run 的耐久证据。
 * 运行中的 Run 没有内存状态机就无法可信重建，调用方应提示用户重新打开 Wave Flow，
 * 绝不能据 Journal 猜测它是否仍在执行。
 */
export async function inspectStoredRun(runId: string, storeRoot = runsRoot()): Promise<RunResponse> {
  const runtime = await RunRuntime.open(runId, new DeterministicExecutor(), storeRoot);
  if (isLiveRunStatus(runtime.snapshot().status)) throw new EngineActionError(409, "Run 仍在受管生命周期内，但当前没有可验证的 Engine；请重新打开 Wave Flow。" );
  return { runId, snapshot: runtime.snapshot() };
}

class EngineActionError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function isEmptyObject(value: unknown): value is Record<string, never> {  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function isCreateRunRequest(value: unknown): value is CreateRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.clientRequestId === "string" && /^[0-9a-f-]{36}$/i.test(request.clientRequestId) && typeof request.workflowPath === "string" && typeof request.cwd === "string" && isJsonObject(request.input);
}


function listItem(runtime: RunRuntime): RunListItem {
  const snapshot = runtime.snapshot();
  const summary = runtime.state.currentAttemptSummary();
  return { runId: snapshot.id, workflow: { name: snapshot.workflow.name, description: snapshot.workflow.description }, status: snapshot.status, cwd: snapshot.cwd, createdAt: snapshot.createdAt, endedAt: snapshot.endedAt, diagnostic: snapshot.diagnostic, hasBlockedAgent: summary.phases.some((phase) => (phase.statusCounts.blocked ?? 0) > 0) };
}

function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1; }

function isLiveRunStatus(status: import("../runtime/run-types").RunStatus): boolean {
  return status === "running" || status === "pausing" || status === "paused" || status === "recovering";
}

/**
 * detectCliKind 的种类关键字表：先按 basename 包含匹配，再按 --version 输出匹配。
 * 关键字只与 CLI 名本身对应（claude/dsh/kimi/codex 互不重叠），新增 CLI 在此登记。
 */
const CLI_KIND_KEYWORDS: ReadonlyArray<{ readonly cli: RuntimeCli; readonly keyword: string }> = [
  { cli: "codex", keyword: "codex" },
  { cli: "kimi", keyword: "kimi" },
  { cli: "claude", keyword: "claude" },
  { cli: "dsh", keyword: "dsh" },
];

/**
 * 把手动验证时上游适配器的进程退出错误翻译成可操作的中文提示。
 * 未知错误保持原文，避免用泛化文案抹掉真实诊断。
 */
function describeCliValidationFailure(error: unknown, requested: RuntimeCli): string {
  const text = error instanceof Error ? error.message : String(error);
  // dsh 在 Node ≤22 下静默退出 0 且零输出：表现为版本读取失败（退出 0、空输出）或握手超时。
  if (requested === "dsh" && (/无法读取 .* 版本/.test(text) || /超时|abort/i.test(text))) return "DeepSeek Harness（dsh）需要 Node ≥ 24 运行时；旧版本 Node 下 dsh 会静默退出且没有任何输出。请确认已验证的 node 为 Node 24 或更高版本后重试。";
  const exited = /process has exited with code (-?\d+)/i.exec(text);
  if (!exited) return text;
  if (/unknown command ['"`]?app-server/i.test(text)) return "这个程序不提供 Codex 的 ACP 入口（app-server），它不是 Codex CLI。请确认路径，或把 CLI 种类改为其他已支持的 CLI 后重试。";
  const label = adapterForCli(requested).displayName;
  return `这个程序启动后立即退出（退出码 ${exited[1]}），无法建立 ACP 会话。请确认它是可用的 ${label} CLI，并在终端能直接运行。`;
}
