import { createHash } from "node:crypto";
import { renderAgentIdentity } from "../cli/agent-identity";
import { AcpSessionClient, type AcpLauncher, type AcpSessionBinding } from "../adapters/acp-session";
import type { ControlServer } from "../control/control-server";
import type { JsonObject } from "../shared/json";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";
import type { RuntimeProvenance } from "../runtimes/types";

/** ACP Worker 会话的最小使用面，便于在不依赖真实模型的情况下验证 Runtime/Control 边界。 */
export interface AcpWorkerSession {
  /** 当前已验证的原生 ACP session binding；recover 不得切换到另一 session。 */
  readonly binding: AcpSessionBinding | null;
  initialize(signal: AbortSignal): Promise<unknown>;
  createSession(cwd: string, signal: AbortSignal): Promise<AcpSessionBinding>;
  prompt(text: string, signal: AbortSignal): Promise<{ readonly stopReason: string }>;
  cancel(signal: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * ACP Worker 执行器。
 *
 * 仅处理同一 daemon 生命周期内的 Codex ACP Worker。ACP 原生 session binding 在
 * `agent.session` 耐久后才允许 Control complete；ACP turn 结束不等于节点完成。
 * 跨 daemon reclaim 还没有经过 session/load 身份验证，因此本执行器不实现它。
 */
export class AcpWorkerExecutor implements AgentNodeExecutor {
  #control: ControlServer | null = null;
  #active = new Map<string, ActiveAcpWorker>();

  constructor(
    private readonly launcher: AcpLauncher,
    // Worker 是 Runtime 已授权的真实执行面，读写与 shell 权限不由 Harness Shell Policy 限制。
    private readonly createSession: (launcher: AcpLauncher) => AcpWorkerSession = (value) => new AcpSessionClient(value, undefined, "allow"),
    /** 已验证用户 CLI 的来源；遗留 Journal 可省略，新的 Runtime 路径必须提供。 */
    private readonly runtime?: RuntimeProvenance,
  ) {}

  /** Runtime 创建当前 Run 的 Control 后调用；缺失时绝不启动真实 Agent。 */
  bindControl(control: ControlServer): void {
    if (this.#control) throw new Error("ACP Worker 执行器已绑定 ControlServer。 ");
    this.#control = control;
  }

  async execute(node: AgentNodeSnapshot): Promise<JsonObject> {
    const control = this.#control;
    if (!control) throw new Error("ACP Worker 执行器尚未绑定 ControlServer。 ");
    if (!node.agentSessionId) throw new Error("ACP Worker 节点缺少 agentSessionId。 ");
    if (node.cli !== "codex") throw new Error(`一期 ACP Worker 只支持 cli: codex，收到 ${node.cli}。`);
    const capability = crypto.randomUUID();
    const reclaimTokenHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    let settled = false;
    let resolveCompletion!: (result: JsonObject) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<JsonObject>((resolve, reject) => {
      resolveCompletion = (result) => { if (!settled) { settled = true; resolve(result); } };
      rejectCompletion = (error) => { if (!settled) { settled = true; reject(error); } };
    });
    void completion.catch(() => undefined);
    control.register({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, capability, reclaimTokenHash, onCompleted: resolveCompletion });
    // short-lived capability 只注入本节点 ACP 子进程；稳定三元组只用于定位，不能单独
    // 授权 active daemon 的 complete/block/continue。
    const launcher: AcpLauncher = { ...this.launcher, env: { ...this.launcher.env, WF_CONTROL_CAPABILITY: capability } };
    const session = this.createSession(launcher);
    const key = nodeKey(node);
    const active: ActiveAcpWorker = { session, reject: rejectCompletion, isSettled: () => settled, turn: null, pauseRequested: false, paused: false, stopped: false, resume: null, releaseResume: null, recoveryStarted: null, resolveRecoveryStarted: null, cancelAck: null, resolveCancelAck: null, controlCommand: launcher.env?.WAVE_FLOW_CONTROL_COMMAND ?? "wave-flow" };
    this.#active.set(key, active);
    try {
      const signal = new AbortController();
      await session.initialize(signal.signal);
      const binding = await session.createSession(node.cwd, signal.signal);
      await control.recordSession({
        runId: control.runId,
        nodeId: node.id,
        agentSessionId: node.agentSessionId,
        delivery: "acp",
        acp: { launcherId: binding.launcherId, sessionId: binding.sessionId, capabilities: binding.capabilities, ...(this.runtime ? { runtime: this.runtime } : {}) },
      });
      const turn = this.runTurn(active, managedPrompt(node, renderAgentIdentity({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId }), launcher.env?.WAVE_FLOW_CONTROL_COMMAND ?? "wave-flow"), signal.signal);
      // Control complete 是 Worker 的业务完成边界。某些 ACP Agent 在工具调用后会继续
      // 保持原 prompt turn；不能因此阻塞 Runtime 的 run.completed。turn 的拒绝仍被
      // race handler 消费，避免 complete 之后形成未处理 rejection。
      return await Promise.race([completion, turn.then(() => completion)]);
    } catch (error) {
      control.unregister(control.runId, node.id, node.agentSessionId);
      throw error;
    } finally {
      this.#active.delete(key);
      session.close();
    }
  }

  /** 同一 daemon 内暂停：cancel 必须真实以 cancelled 结束，不能把未知中断伪装为 paused。 */
  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> {
    const active = this.requireActive(node);
    if (active.paused || active.pauseRequested) throw new Error("ACP Worker 已在暂停控制中。 ");
    if (!active.turn) throw new Error("ACP Worker 尚未建立可取消的当前 turn，拒绝伪造暂停。 ");
    active.pauseRequested = true;
    try {
      active.resume = new Promise<void>((resolve) => { active.releaseResume = resolve; });
      active.cancelAck = new Promise<void>((resolve) => { active.resolveCancelAck = resolve; });
      await active.session.cancel(signal ?? AbortSignal.timeout(15_000));
      await active.cancelAck;
      active.paused = true;
    } catch (error) {
      active.pauseRequested = false;
      throw error;
    }
  }

  /** 同一 ACP session 发新的检查现场回合；新 prompt 实际发起后才报告 recover 成功。 */
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<{}> {
    const active = this.requireActive(node);
    if (!active.paused || !active.releaseResume) throw new Error("ACP Worker 未处于可恢复暂停状态。 ");
    active.recoveryStarted = new Promise<void>((resolve) => { active.resolveRecoveryStarted = resolve; });
    active.paused = false;
    active.pauseRequested = false;
    active.releaseResume();
    active.releaseResume = null;
    await awaitWithSignal(active.recoveryStarted, signal);
    const binding = active.session.binding;
    if (!binding) throw new Error("ACP Worker 恢复回合缺少已验证 session binding。 ");
    return { acp: { launcherId: binding.launcherId, sessionId: binding.sessionId } };
  }

  /** 用户 stop 仅取消当前 ACP turn；Runtime 负责耐久写入 cancelled。 */
  async stop(node: AgentNodeSnapshot): Promise<void> {
    const active = this.requireActive(node);
    if (active.paused) {
      active.stopped = true;
      active.releaseResume?.();
      setTimeout(() => active.reject(new Error("用户停止 Run。")), 0);
      return;
    }
    await active.session.cancel(AbortSignal.timeout(15_000));
    // Runtime 在 stop() 返回后先写 cancelled；下一轮事件循环再结束 execute，避免抢写 interrupted。
    setTimeout(() => active.reject(new Error("用户停止 Run。")), 0);
  }

  private async runTurn(active: ActiveAcpWorker, prompt: string, signal: AbortSignal, onStarted?: () => void): Promise<void> {
    active.turn = active.session.prompt(prompt, signal);
    // `session.prompt()` 已向 ACP transport 建立该恢复请求；后续 promise 只会在 turn
    // 结束时 resolve，不能拿结束事件当作“已开始”的唯一信号。
    onStarted?.();
    const turn = await active.turn;
    active.turn = null;
    if (active.isSettled()) return;
    if (active.pauseRequested && turn.stopReason === "cancelled") {
      active.resolveCancelAck?.();
      active.resolveCancelAck = null;
      await active.resume;
      if (active.isSettled() || active.stopped) return;
      return this.runTurn(active, recoveryPrompt(active.controlCommand), signal, () => {
        active.resolveRecoveryStarted?.();
        active.resolveRecoveryStarted = null;
      });
    }
    if (active.pauseRequested) throw new Error(`ACP cancel 未确认 cancelled，实际为 ${turn.stopReason}。`);
    throw new Error(`ACP Worker turn 已结束（${turn.stopReason}），但未收到 wave-flow complete。`);
  }

  private requireActive(node: AgentNodeSnapshot): ActiveAcpWorker {
    const active = this.#active.get(nodeKey(node));
    if (!active) throw new Error(`节点 ${node.id} 没有可控制的 ACP Worker 会话。`);
    return active;
  }
}

type ActiveAcpWorker = {
  readonly session: AcpWorkerSession;
  readonly reject: (error: Error) => void;
  readonly isSettled: () => boolean;
  turn: Promise<{ readonly stopReason: string }> | null;
  pauseRequested: boolean;
  paused: boolean;
  stopped: boolean;
  resume: Promise<void> | null;
  releaseResume: (() => void) | null;
  recoveryStarted: Promise<void> | null;
  resolveRecoveryStarted: (() => void) | null;
  cancelAck: Promise<void> | null;
  resolveCancelAck: (() => void) | null;
  controlCommand: string;
};

function nodeKey(node: AgentNodeSnapshot): string { return `${node.id}:${node.agentSessionId ?? ""}`; }

function managedPrompt(node: AgentNodeSnapshot, identity: string, controlCommand: string): string {
  return `${node.request.prompt}\n\n本 Agent 的稳定控制身份（不是秘密；每次控制命令必须原样携带）：${identity}\n\n完成任务后必须执行以下步骤：\n1. 将最终结构化结果写入一个绝对路径的 JSON 文件，文件内容必须是 JSON 对象。\n2. 执行 ${controlCommand} complete --summary <简短完成说明> --result-file <该绝对路径> ${identity}。\n若遇到无法安全继续的需求、环境或逻辑阻塞，执行 ${controlCommand} block --need-help <完整说明> [--answer-schema <JSON Schema>] ${identity}；命令会返回 blockRequestId 和 JSON 答案。验证答案已解决阻塞后，再执行 ${controlCommand} continue --block-request-id <该 id> ${identity}。\n不要仅用自然语言声称完成；只有上述命令成功后节点才会完成。`;
}

function recoveryPrompt(controlCommand: string): string {
  return `这是 Wave Flow 用户授权的恢复。上一回合已被取消，不能假设它未产生副作用。请先检查当前工作目录、Git 状态、已生成文件、测试和命令结果，再从已有现场继续；不要重发原始任务。完成仍须执行既有 ${controlCommand} complete；无法安全判断时使用 ${controlCommand} block。`;
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("ACP Worker recover 已取消。 ");
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => signal.addEventListener("abort", () => reject(new Error("ACP Worker recover 已取消。 ")), { once: true })),
  ]);
}
