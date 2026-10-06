import { join } from "node:path";
import { createHash } from "node:crypto";
import { renderAgentIdentity } from "../cli/agent-identity";
import { CodexInteractiveAdapter } from "../adapters/codex-interactive-adapter";
import type { ControlServer } from "../control/control-server";
import { nodeDirectoryName } from "../journal/paths";
import type { SessionBackend, SessionIdentity } from "../sessions/types";
import { InteractiveCliBootstrap } from "../sessions/bootstrap/interactive-cli-bootstrap";
import type { InteractiveCliStartRequest } from "../adapters/interactive-cli-adapter";
import type { JsonObject } from "../shared/json";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";
import { CodexAppServerAdapter, CodexAppServerAmbiguousSubmissionError, type CodexAppServerBinding, CodexAppServerHost, bunCodexAppServerConnection, createCodexRemoteViewer } from "../adapters/codex-app-server";
import { probeCapabilities } from "../daemon/capability-probe";
import type { CapabilitySnapshot, CapabilityStatus } from "../adapters/capabilities";

/** 默认 Codex 真实执行器：以 App Server ACK 投递首条任务，并创建 tmux remote viewer。 */
export class RealCodexExecutor implements AgentNodeExecutor {
  #control: ControlServer | null = null;
  #active = new Map<string, ActiveHybridNode>();

  /** @param controlUrl 仅用于当前 daemon 内部注册；不直接注入 Agent 工具环境。 */
  constructor(
    private readonly sessions: SessionBackend,
    private readonly controlUrl: string,
    private readonly runsRoot: string,
    private readonly startSession: (sessions: SessionBackend, adapter: CodexInteractiveAdapter, request: InteractiveCliStartRequest) => Promise<{ readonly identity: SessionIdentity }> = defaultStartSession,
    private readonly livenessPollMs = 1_000,
    private readonly codexRpcInput = true,
    private readonly startHybrid: (sessions: SessionBackend, node: AgentNodeSnapshot, prompt: string, identityFile: string, env: Readonly<Record<string, string>>, reclaimTokenHash: string) => Promise<{ readonly identity: SessionIdentity; readonly binding: CodexAppServerBinding; /** 当前 App Server 的控制 Adapter；生产 pause/recover 必须提供，历史 fake 可省略。 */ readonly adapter?: CodexAppServerAdapter; /** App Server 进程退出时 resolve；fake 启动器可省略。 */ readonly exited?: Promise<number>; stop(): void }> = defaultStartHybrid,
  ) {}

  /** Runtime 创建 ControlServer 后绑定；未绑定时拒绝启动，避免无 capability 的真实 Agent。 */
  bindControl(control: ControlServer): void {
    if (this.#control) throw new Error("真实 Codex 执行器已绑定 ControlServer。");
    this.#control = control;
  }

  /** 启动前重新读取本机 tmux 与 Codex 二进制状态；unknown 绝不被当成可用。 */
  probeCapabilities(): Promise<CapabilitySnapshot> { return probeCapabilities(); }

  /** 当前真实路径至少需要可创建私有 tmux 会话与可执行的 Codex；首条投递另由 Gate 验证。 */
  requiredCapabilities(): Readonly<Record<string, (snapshot: CapabilitySnapshot) => CapabilityStatus>> {
    return {
      "tmux.persistentSessions": (snapshot) => snapshot.host.tmux.persistentSessions,
      "codex.binary": (snapshot) => snapshot.adapters.codex.status,
    };
  }

  /** 创建真实 tmux/Codex 会话，确认首条 Prompt 后注册 capability，并等待 complete 回调。 */
  async execute(node: AgentNodeSnapshot): Promise<JsonObject> {
    const control = this.#control;
    if (!control) throw new Error("真实 Codex 执行器尚未绑定 ControlServer。");
    if (!node.agentSessionId) throw new Error("真实 Codex 节点缺少 agentSessionId。");
    const capability = crypto.randomUUID();
    const reclaimTokenHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    const sessionEnv = {
        WF_RUN_ID: control.runId,
        WF_NODE_ID: node.id,
        WF_AGENT_SESSION_ID: node.agentSessionId,
      };
    let settled = false;
    let resolveCompletion!: (result: JsonObject) => void;
    let rejectCompletion!: (error: Error) => void;
    const completionWithFailure = new Promise<JsonObject>((resolve, reject) => {
      resolveCompletion = (result) => { if (!settled) { settled = true; resolve(result); } };
      rejectCompletion = (error) => { if (!settled) { settled = true; reject(error); } };
    });
    // App Server 退出可能在调用方拿到 execute() 返回 Promise 前发生；先登记一个
    // 旁路 rejection handler，避免 Bun 将正确传播给调用方的中断误报为未处理拒绝。
    void completionWithFailure.catch(() => undefined);
    control.register({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, capability, reclaimTokenHash, onCompleted: resolveCompletion });
    let stopHybrid: (() => void) | null = null;
    const cleanupHybrid = () => { if (stopHybrid !== null) stopHybrid(); };
    try {
      const identityFile = join(this.runsRoot, control.runId, "nodes", nodeDirectoryName(node.id), "session.json");
      let started: { readonly identity: SessionIdentity };
      let hybridBinding: CodexAppServerBinding | null = null;
      if (this.codexRpcInput) {
        try {
          const hybrid = await this.startHybrid(this.sessions, node, managedPrompt(node, renderAgentIdentity({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId })), identityFile, sessionEnv, reclaimTokenHash);
          started = hybrid;
          stopHybrid = hybrid.stop;
          hybridBinding = hybrid.binding;
          if (hybrid.adapter) this.#active.set(nodeKey(node), { node, identity: started.identity, binding: hybrid.binding, adapter: hybrid.adapter, sessions: this.sessions, runsRoot: this.runsRoot, env: sessionEnv, reclaimTokenHash, stop: hybrid.stop, reject: rejectCompletion, isSettled: () => settled, paused: false, pauseInProgress: false });
          if (hybrid.exited) {
            void hybrid.exited.then((code) => {
              if (settled || this.#active.get(nodeKey(node))?.paused === true || this.#active.get(nodeKey(node))?.pauseInProgress === true) return;
              control.unregister(control.runId, node.id, node.agentSessionId!);
              cleanupHybrid();
              rejectCompletion(new Error(`Codex App Server 进程已退出：${code}`));
            }).catch((error) => {
              if (settled || this.#active.get(nodeKey(node))?.paused === true || this.#active.get(nodeKey(node))?.pauseInProgress === true) return;
              control.unregister(control.runId, node.id, node.agentSessionId!);
              cleanupHybrid();
              rejectCompletion(new Error(`Codex App Server 退出状态不可验证：${error instanceof Error ? error.message : String(error)}`));
            });
          }
        } catch (error) {
          if (error instanceof CodexAppServerAmbiguousSubmissionError) throw error;
          started = await this.startOrdinary(node, control.runId, identityFile, sessionEnv, reclaimTokenHash, renderAgentIdentity({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId }));
        }
      } else {
        started = await this.startOrdinary(node, control.runId, identityFile, sessionEnv, reclaimTokenHash, renderAgentIdentity({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId }));
      }
      if (started.identity.reclaimTokenHash !== reclaimTokenHash) throw new Error("SessionBackend 返回的会话未携带匹配的 reclaim token hash。");
      await control.recordSession(hybridBinding
        ? { runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, session: started.identity, delivery: "codex-rpc", appServer: hybridBinding }
        : { runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, session: started.identity, delivery: "tmux" });
      void this.monitorSession(started.identity, () => settled || this.#active.get(nodeKey(node))?.pauseInProgress === true || this.#active.get(nodeKey(node))?.paused === true, (error) => {
        control.unregister(control.runId, node.id, node.agentSessionId!);
        cleanupHybrid();
        rejectCompletion(error);
      });
      return completionWithFailure.finally(() => { this.#active.delete(nodeKey(node)); cleanupHybrid(); });
    } catch (error) {
      cleanupHybrid();
      control.unregister(control.runId, node.id, node.agentSessionId);
      throw error;
    }
  }

  /** App Server 当前 turn + 受管背景终端都已停止，并关闭 viewer 防止绕过 recover 输入。 */
  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> {
    const active = this.requireActive(node);
    active.pauseInProgress = true;
    try {
      if (!active.sessions.closeViewer) throw new Error("当前 Session Host 不支持无输入关闭 viewer。 ");
      await active.sessions.closeViewer(active.identity).then((result) => {
        if (result.status !== "destroyed") throw new Error(`无法确认关闭 tmux viewer：${result.diagnostic ?? "unknown"}`);
      });
      // blocked 节点的原 Agent 正在等待 wave-flow block HTTP；不应对不存在的
      // active turn 再发 interrupt。关闭 viewer 后保留该等待，recover 时回到 blocked。
      const control = controlSignal(signal);
      if (!node.block) await active.adapter.interrupt(active.binding.threadId, active.binding.turnId, control);
      await active.adapter.cleanBackgroundTerminals(active.binding.threadId, control);
      const remaining = await active.adapter.listBackgroundTerminals(active.binding.threadId, control);
      if (remaining.length > 0) throw new Error(`App Server 仍有 ${remaining.length} 个背景终端未停止。`);
      active.paused = true;
    } catch (error) {
      throw new Error(`暂停 Codex App Server 节点失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      active.pauseInProgress = false;
    }
  }

  /** 同一 thread 获取新 turn ACK 后重建 viewer；旧 Prompt 不会被重发。 */
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<import("./run-types").AgentRecovery> {
    const active = this.requireActive(node);
    if (!active.paused) throw new Error("节点未处于可恢复暂停状态。 ");
    const submission = node.block
      ? { binding: active.binding }
      : await active.adapter.submitRecoveryPrompt(node, active.binding.threadId, recoveryPrompt(node), controlSignal(signal));
    const identityFile = join(active.runsRoot, this.#control!.runId, "nodes", nodeDirectoryName(node.id), "session.json");
    const viewer = await createCodexRemoteViewer(active.sessions, { runId: this.#control!.runId, node, identityFile, reclaimTokenHash: active.reclaimTokenHash, env: active.env }, submission.binding);
    active.identity = viewer;
    active.binding = submission.binding;
    active.paused = false;
    void this.monitorSession(viewer, () => active.isSettled() || active.pauseInProgress || active.paused, active.reject);
    return node.block ? {} : { appServer: { ...submission.binding, protocolVersion: 1 } };
  }

  viewerSession(node: AgentNodeSnapshot): SessionIdentity | null { return this.#active.get(nodeKey(node))?.identity ?? null; }

  /** 用户 stop：停止受管 turn / 工具并让 agent() 结束，不保留 recover。 */
  async stop(node: AgentNodeSnapshot): Promise<void> {
    const active = this.requireActive(node);
    if (!active.paused && active.sessions.closeViewer) {
      const result = await active.sessions.closeViewer(active.identity);
      if (result.status !== "destroyed") throw new Error(`无法确认关闭 tmux viewer：${result.diagnostic ?? "unknown"}`);
    }
    // paused 已完成 interrupt + clean + 空清单验证；再次 stop 不得对旧 turn 重发
    // interrupt，否则 App Server 可能将“无 active turn”当作错误而阻止用户终止 Run。
    if (!active.paused) {
      await active.adapter.interrupt(active.binding.threadId, active.binding.turnId, AbortSignal.timeout(15_000));
      await active.adapter.cleanBackgroundTerminals(active.binding.threadId, AbortSignal.timeout(15_000));
      if ((await active.adapter.listBackgroundTerminals(active.binding.threadId, AbortSignal.timeout(15_000))).length > 0) throw new Error("App Server 背景终端仍未停止。 ");
    }
    // Runtime 在本次 stop() await 返回后先耐久写入 agent.cancelled。若此处同步
    // reject，agent() 的 catch 可能抢先写 agent.interrupted，破坏“用户停止”语义。
    // 下一轮事件循环再结束执行 Promise，届时 Host 会看到 cancelled 而不覆盖状态。
    setTimeout(() => active.reject(new Error("用户停止 Run。")), 0);
  }

  private requireActive(node: AgentNodeSnapshot): ActiveHybridNode {
    const active = this.#active.get(nodeKey(node));
    if (!active) throw new Error(`节点 ${node.id} 没有可控制的 App Server 会话。`);
    return active;
  }

  private startOrdinary(node: AgentNodeSnapshot, runId: string, identityFile: string, sessionEnv: Readonly<Record<string, string>>, reclaimTokenHash: string, identity: string): Promise<{ readonly identity: SessionIdentity }> {
    return this.startSession(this.sessions, new CodexInteractiveAdapter(this.sessions, { sessionEnv }), { runId, node, prompt: managedPrompt(node, identity), identityFile, reclaimTokenHash });
  }

  private async monitorSession(identity: SessionIdentity, isSettled: () => boolean, reject: (error: Error) => void): Promise<void> {
    while (true) {
      await delay(this.livenessPollMs);
      if (isSettled()) return;
      const live = await this.sessions.liveness(identity);
      if (live === "exists") continue;
      reject(new Error(`真实 Agent 会话无法继续验证：${live}`));
      return;
    }
  }
}

async function defaultStartSession(sessions: SessionBackend, adapter: CodexInteractiveAdapter, request: InteractiveCliStartRequest): Promise<{ readonly identity: SessionIdentity }> {
  return new InteractiveCliBootstrap(sessions).start(adapter, request);
}

function managedPrompt(node: AgentNodeSnapshot, identity: string): string {
  return `${node.request.prompt}\n\n本 Agent 的稳定控制身份（不是秘密；每次控制命令必须原样携带）：${identity}\n\n完成任务后必须执行以下步骤：\n1. 将最终结构化结果写入一个绝对路径的 JSON 文件，文件内容必须是 JSON 对象。\n2. 执行 wave-flow complete --summary <简短完成说明> --result-file <该绝对路径> ${identity}。\n若遇到无法安全继续的需求、环境或逻辑阻塞，执行 wave-flow block --need-help <完整说明> [--answer-schema <JSON Schema>] ${identity}；命令会返回 blockRequestId 和 JSON 答案。验证答案已解决阻塞后，再执行 wave-flow continue --block-request-id <该 id> ${identity}。\n不要仅用自然语言声称完成；只有上述命令成功后节点才会完成。`;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/** 每个控制调用都有 15 秒上限，且 stop 可提前 abort 当前 pause/recover。 */
function controlSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function defaultStartHybrid(sessions: SessionBackend, node: AgentNodeSnapshot, prompt: string, identityFile: string, env: Readonly<Record<string, string>>, reclaimTokenHash: string): Promise<{ readonly identity: SessionIdentity; readonly binding: CodexAppServerBinding; readonly adapter: CodexAppServerAdapter; readonly exited: Promise<number>; stop(): void }> {
  const host = new CodexAppServerHost(undefined, "codex", 10_000, env);
  try {
    const endpoint = await host.start(bunCodexAppServerConnection, new AbortController().signal);
    const adapter = new CodexAppServerAdapter(endpoint, bunCodexAppServerConnection);
    const submission = await adapter.submitInitialPrompt(node, prompt, new AbortController().signal);
    let identity: SessionIdentity;
    try {
      identity = await createCodexRemoteViewer(sessions, { runId: env.WF_RUN_ID, node, identityFile, reclaimTokenHash, env }, submission.binding);
    } catch (error) {
      throw new CodexAppServerAmbiguousSubmissionError(`App Server 已确认首条任务但 remote viewer 创建失败，禁止回退投递：${error instanceof Error ? error.message : String(error)}`);
    }
    return { identity, binding: submission.binding, adapter, exited: host.exited, stop: () => { void adapter.close(); host.stop(); } };
  } catch (error) {
    host.stop();
    throw error;
  }
}

type ActiveHybridNode = {
  readonly node: AgentNodeSnapshot;
  identity: SessionIdentity;
  binding: CodexAppServerBinding;
  readonly adapter: CodexAppServerAdapter;
  readonly sessions: SessionBackend;
  readonly runsRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly reclaimTokenHash: string;
  readonly stop: () => void;
  readonly reject: (error: Error) => void;
  readonly isSettled: () => boolean;
  paused: boolean;
  /** viewer 关闭到 paused 事实落盘之间，liveness 缺失是预期而非会话崩溃。 */
  pauseInProgress: boolean;
};

function nodeKey(node: AgentNodeSnapshot): string { return `${node.id}:${node.agentSessionId ?? ""}`; }

function recoveryPrompt(node: AgentNodeSnapshot): string {
  return `这是 Wave Flow 用户授权的恢复。上一回合已经被停止，不能假设它未产生副作用。请先检查当前工作目录、Git 状态、已生成文件、测试和命令结果，从已有现场继续完成原任务“${node.request.prompt}”。不确定某项有副作用步骤是否执行过时，先检查证据；无法安全判断时使用 wave-flow block --need-help 求助。`;
}
