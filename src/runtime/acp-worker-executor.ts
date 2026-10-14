import { AcpSessionClient, type AcpLauncher, type AcpSessionBinding } from "../adapters/acp-session";
import type { ControlServer } from "../control/control-server";
import type { JsonObject } from "../shared/json";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";
import type { RuntimeProvenance } from "../runtimes/types";
import type * as acp from "@agentclientprotocol/sdk";

/** ACP Worker 会话的最小使用面，便于在不依赖真实模型的情况下验证 Runtime/Control 边界。 */
export interface AcpWorkerSession {
  /** 当前已验证的原生 ACP session binding；recover 不得切换到另一 session。 */
  readonly binding: AcpSessionBinding | null;
  initialize(signal: AbortSignal): Promise<unknown>;
  createSession(cwd: string, signal: AbortSignal, mcpServers?: acp.McpServer[], mcpStartupAwaitMs?: number): Promise<AcpSessionBinding>;
  prompt(text: string, signal: AbortSignal): Promise<{ readonly stopReason: string }>;
  cancel(signal: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * ACP Worker 执行器。
 *
 * 仅处理同一 Engine 生命周期内的 Codex ACP Worker。ACP 原生 session binding 在
 * `agent.session` 耐久后才允许 Control complete；ACP turn 结束不等于节点完成。
 * 跨 Engine 不认领 ACP session；用户显式 resume 才会创建新 attempt。
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
    /** 每个 Worker session 私有的 Control MCP；省略仅供旧测试夹具。 */
    private readonly createControlMcp?: (value: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly capability: string }) => acp.McpServer,
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
    let settled = false;
    let resolveCompletion!: (result: JsonObject) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<JsonObject>((resolve, reject) => {
      resolveCompletion = (result) => { if (!settled) { settled = true; resolve(result); } };
      rejectCompletion = (error) => { if (!settled) { settled = true; reject(error); } };
    });
    void completion.catch(() => undefined);
    control.register({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, capability, onCompleted: resolveCompletion });
    // capability 只保留在 Engine 与私有 MCP server 的绑定中，绝不注入 ACP adapter
    // 或 Coding Worker 的环境。稳定三元组只用于定位，不能单独授权上报。
    const session = this.createSession(this.launcher);
    let mcpServers: acp.McpServer[] = [];
    const key = nodeKey(node);
    const active: ActiveAcpWorker = { session, reject: rejectCompletion, isSettled: () => settled, turn: null, pauseRequested: false, paused: false, stopped: false, resume: null, releaseResume: null, recoveryStarted: null, resolveRecoveryStarted: null, cancelAck: null, resolveCancelAck: null, completionReminderSent: false };
    this.#active.set(key, active);
    try {
      const signal = new AbortController();
      await session.initialize(signal.signal);
      mcpServers = this.createControlMcp ? [this.createControlMcp({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, capability })] : [];
      const binding = await session.createSession(node.cwd, signal.signal, mcpServers, 10_000);
      await control.recordSession({
        runId: control.runId,
        nodeId: node.id,
        agentSessionId: node.agentSessionId,
        delivery: "acp",
        acp: { launcherId: binding.launcherId, sessionId: binding.sessionId, capabilities: binding.capabilities, ...(this.runtime ? { runtime: this.runtime } : {}) },
      });
      const turn = this.runTurn(active, managedPrompt(node), signal.signal);
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
      // Worker 未 complete 就停止、取消或异常结束时也必须回收本 session 的私有
      // Control 通道；它不能存活到整个 Engine 退出后才消失。
      for (const server of mcpServers ?? []) (server as import("@agentclientprotocol/sdk").McpServer & { readonly close?: () => void }).close?.();
    }
  }

  /** 同一 Engine 内暂停：cancel 必须真实以 cancelled 结束，不能把未知中断伪装为 paused。 */
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
      return this.runTurn(active, recoveryPrompt(), signal, () => {
        active.resolveRecoveryStarted?.();
        active.resolveRecoveryStarted = null;
      });
    }
    if (active.pauseRequested) throw new Error(`ACP cancel 未确认 cancelled，实际为 ${turn.stopReason}。`);
    if (!active.completionReminderSent && turn.stopReason === "end_turn") {
      // Agent 的 end_turn 不能推进状态；只在同一原生 session 内补发一次“仅上报”
      // 回合，绝不重发原业务任务或自行推断结果。若它仍不 complete，诚实 interrupted。
      active.completionReminderSent = true;
      return this.runTurn(active, completionReminderPrompt(), signal);
    }
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
  completionReminderSent: boolean;
};

function nodeKey(node: AgentNodeSnapshot): string { return `${node.id}:${node.agentSessionId ?? ""}`; }

function managedPrompt(node: AgentNodeSnapshot): string {
  const schema = node.request.schema ? `\n最终 JSON 必须符合此 resultSchema：${JSON.stringify(node.request.schema)}` : "";
  return `${node.request.prompt}\n\n## Wave Flow 受管节点完成协议（高优先级、不可省略）\n你在受管 Worker 节点内工作，ACP turn 的 end_turn、聊天文本、JSON 文本或“已完成”都不会完成节点。即使业务任务要求“只回复”“只输出 JSON”或不执行命令，也必须先完成以下上报；这些要求不与业务任务冲突。\n\n本 session 注入了三个私有 MCP 工具：wave_flow_complete、wave_flow_block、wave_flow_continue。完成时必须调用 wave_flow_complete 并传入最终 JSON 对象和简短摘要；成功后才可结束 ACP turn。${schema}\n若没有用户决定无法安全继续，调用 wave_flow_block；它返回 blockRequestId 与用户 JSON 答案，确认答案已解决问题后调用 wave_flow_continue。\n\n禁止把自然语言、终端输出或 ACP end_turn 当作成功。未调用 complete 时节点会被标记为 interrupted。`;
}

function recoveryPrompt(): string {
  return "这是 Wave Flow 用户授权的恢复。上一回合已被取消，不能假设它未产生副作用。请先检查当前工作目录、Git 状态、已生成文件、测试和命令结果，再从已有现场继续；不要重发原始任务。完成仍须调用私有 MCP 的 wave_flow_complete；无法安全判断时调用 wave_flow_block。";
}

function completionReminderPrompt(): string {
  return "上一回合已以 ACP end_turn 结束，但 Wave Flow 尚未收到 complete；该回合不构成成功。不要重做业务任务，也不要只回复文本。现在只做受管完成上报：基于刚才已经完成/确认的任务结果，调用私有 MCP 工具 wave_flow_complete 并提供最终 JSON 对象与简短摘要。若无法安全构造结果，改用 wave_flow_block。完成上报后才可结束本回合。";
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("ACP Worker recover 已取消。 ");
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => signal.addEventListener("abort", () => reject(new Error("ACP Worker recover 已取消。 ")), { once: true })),
  ]);
}
