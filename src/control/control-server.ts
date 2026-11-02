import Ajv from "ajv";
import { isDeepStrictEqual } from "node:util";
import { normalizeHitlAnswerSchema } from "../shared/hitl-schema";
import type { RunJournal } from "../journal/run-journal";
import type { JournalEvent } from "../journal/types";
import type { RuntimeProvenance } from "../runtimes/types";
import type { RunStateMachine } from "../runtime/run-state-machine";
import type { JsonObject } from "../shared/json";
import type { JsonSchema } from "../shared/workflow-types";
import { BlockBroker, type BlockAnswerSubmission, type BlockResolution, type BlockStatus, type BlockSubmission, type ContinueSubmission } from "./block-broker";

export type { BlockAnswerSubmission, BlockResolution, BlockStatus, BlockSubmission, ContinueSubmission } from "./block-broker";

/** 注册后仅在当前 Engine 生命周期有效的节点 capability。 */
export type RegisteredControlNode = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 真实 Agent 会话身份；为空时节点尚未接入受管 Control。 */
  readonly agentSessionId: string;
  /** 仅注入受管 Agent 会话环境的高熵 capability。 */
  readonly capability: string;
  /** 节点完成后通知对应真实执行器返回结果；仅 Engine 内部使用，异常不得回滚已完成状态。 */
  readonly onCompleted?: (result: JsonObject) => void;
};

/**
 * 所有 Adapter 共用的节点完成提交。
 *
 * Adapter 只能携带受管会话身份和 JSON 结果调用 Control；它没有 Journal、状态机
 * 或 onCompleted 回调的写入权限，不能自行将节点标记为完成。
 */
export type CompletionSubmission = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 受管 Agent 会话身份。 */
  readonly agentSessionId: string;
  /** 仅注入受管会话环境的 capability。 */
  readonly capability: string;
  /** 可选展示摘要；仅用于诊断，不替代 JSON 结果。 */
  readonly summary: string;
  /** 受管 CLI 已在本地读取的 JSON 对象结果。 */
  readonly result: JsonObject;
};

/** 已确认首条任务投递后的会话记录；只有它耐久后才允许 complete。 */
export type RecordedAgentSession = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 与当前 running 节点一致的会话身份。 */
  readonly agentSessionId: string;
  /** 首条任务的实际投递方式。 */
  readonly delivery: "acp";
  /** ACP Worker 的可审计 binding；不是 capability 或完成证据。 */
  readonly acp?: {
    readonly launcherId: string;
    readonly sessionId: string;
    readonly capabilities: Readonly<Record<string, unknown>>;
    readonly runtime?: RuntimeProvenance;
    /** provider 进程组与启动时间指纹；缺失时不具备跨重启围栏证据。 */
    readonly writer?: { readonly pgid: number; readonly startedAt: string };
  };
};

/** 仅供原执行器收尾使用的当前耐久协议事实；不授权状态转换或携带capability。 */
export type WorkerTurnContext = {
  /** 当前节点状态；仅running/blocked允许收尾，其他状态拒绝。 */
  readonly status: "running" | "blocked";
  /** 原节点输出Schema；缺省null，仍由complete最终校验。 */
  readonly resultSchema: JsonSchema | null;
  /** 原人工请求与已耐久答案；无请求null，答案未交付时null，不补造。 */
  readonly block: {
    /** 原耐久请求UUID；重连与continue须保持，不是授权秘密。 */
    readonly blockRequestId:string;
    /** 原完整帮助正文，只作为数据，重连不得修改。 */
    readonly needHelp:string;
    /** 原答案Schema；未声明时null，不新增约束。 */
    readonly answerSchema:JsonSchema|null;
    /** 原耐久答案副本；未交付null，存在也不自动continue。 */
    readonly answer:JsonObject|null;
    /** 当前表单交付状态；closed 时禁止 Executor 自动重问，必须等待用户显式重开。 */
    readonly delivery:"pending"|"answered"|"closed"|"delivered";
  } | null;
};

/** ACP Adapter 转发给当前 Worker 的表单请求；只用于复核并等待既有 block。 */
export type WorkerElicitationRequest = {
  /** 请求模式；当前只接受 form。 */
  readonly mode: string;
  /** 必须与原 needHelp 完全一致的问题正文。 */
  readonly message: string;
  /** 必须与原 answerSchema 规范化后一致的表单约束。 */
  readonly requestedSchema: JsonObject;
  /** Codex 可选透传的请求身份；仅用于一致性复核，不是授权依据。 */
  readonly blockRequestId?: string;
};

/** Control Server 的最小 complete 协议。 */
export class ControlServer {
  #nodes = new Map<string, RegisteredControlNode>();
  #completing = new Set<string>();
  #recordedSessions = new Set<string>();
  #blocks = new BlockBroker();
  #answering = new Set<string>();
  #continuing = new Set<string>();
  #blocking = new Set<string>();

  constructor(
    private readonly journal: RunJournal,
    private readonly state: RunStateMachine,
    /**
     * 同一 Run 的耐久事实互斥区。Worker 控制 socket 上报与用户 IPC 控制（stop/退出）没有
     * 共享调用栈：校验、结果/校验文件写入、Journal 追加与内存 apply 必须在同一
     * 临界区内完成，否则 cancelled 会插进 complete 的磁盘窗口，使档案永久不可重放。
     */
    private readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
  ) {}

  /** 当前 Control 所属 Run；供真实执行器构造受管环境，不对 Workflow 作者 API 暴露。 */
  get runId(): string { return this.journal.manifest.runId; }

  /** 注册一个已进入 running 的真实 Agent；同一 node/session 只能注册一次。 */
  register(node: RegisteredControlNode): void {
    if (node.runId !== this.journal.manifest.runId) throw new Error("Control 节点不属于当前 Run。");
    if (!node.agentSessionId.trim() || !node.capability.trim()) throw new Error("Control 注册缺少会话身份或 capability。");
    const snapshot = this.state.agent(node.nodeId);
    if (snapshot.status !== "running" || snapshot.agentSessionId !== node.agentSessionId) throw new Error("Control 只能注册当前 running 的同一 Agent 会话。");
    const key = controlKey(node.runId, node.nodeId);
    if (this.#nodes.has(key)) throw new Error("Control 节点已注册。");
    this.#nodes.set(key, node);
  }

  /**
   * 同一 attempt 内换 Control capability。
   *
   * 原地续用会重建私有 MCP server（新 socket、新 capability），但节点、会话与 attempt 不变；
   * 旧 capability 必须立即失效，block 等待关系保持不变，因此不能用 unregister（它会关闭 block）。
   */
  rebind(node: RegisteredControlNode): void {
    if (node.runId !== this.journal.manifest.runId) throw new Error("Control 节点不属于当前 Run。");
    if (!node.agentSessionId.trim() || !node.capability.trim()) throw new Error("Control 重绑缺少会话身份或 capability。");
    const key = controlKey(node.runId, node.nodeId);
    const existing = this.#nodes.get(key);
    if (!existing) throw new Error("Control 节点尚未注册，不能重绑。");
    if (existing.agentSessionId !== node.agentSessionId) throw new Error("Control 重绑不得替换会话身份。");
    if (existing.capability === node.capability) throw new Error("Control 重绑必须使用新的 capability。");
    const snapshot = this.state.agent(node.nodeId);
    if ((snapshot.status !== "running" && snapshot.status !== "recovering") || snapshot.agentSessionId !== node.agentSessionId) throw new Error("Control 只能重绑当前 running/recovering 的同一 Agent 会话。");
    this.#nodes.set(key, node);
  }

  /** 启动失败时撤销尚未完成的 capability；已完成节点不会被撤销。 */
  unregister(runId: string, nodeId: string, agentSessionId: string): void {    const key = controlKey(runId, nodeId);
    const node = this.#nodes.get(key);
    if (node?.agentSessionId === agentSessionId) {
      this.#blocks.cancelForSession(runId, nodeId, agentSessionId, "原 Agent 会话已结束，无法继续等待人工答案。");
      this.#nodes.delete(key);
      this.#recordedSessions.delete(key);
    }
  }

  /** 耐久记录已投递任务的会话坐标，避免 complete 指向不可恢复或错误的终端。 */
  async recordSession(record: RecordedAgentSession): Promise<void> {
    await this.exclusive(async () => {
    const key = controlKey(record.runId, record.nodeId);
    const node = this.#nodes.get(key);
    if (!node || node.agentSessionId !== record.agentSessionId) throw new Error("会话记录的 Control 节点或会话身份不匹配。");
    if (this.#recordedSessions.has(key)) throw new Error("该节点的会话坐标已记录。");
    const snapshot = this.state.agent(record.nodeId);
    if (snapshot.status !== "running" || snapshot.agentSessionId !== record.agentSessionId) throw new Error("只能记录当前 running 节点的会话坐标。");
    if (!record.acp || !record.acp.launcherId || !record.acp.sessionId) throw new Error("ACP 投递缺少 launcher/session 坐标。");
    const event: JournalEvent = {
      type: "agent.session", at: new Date().toISOString(), runId: record.runId, nodeId: record.nodeId,
      agentSessionId: record.agentSessionId, diagnostic: record.delivery,
      delivery: "acp", acp: record.acp,
    };
    this.state.assertApplicable(event);
    await this.journal.append(event);
    this.state.apply(event);
    this.#recordedSessions.add(key);
    });
  }

  /** 同一 attempt 内更新 provider 进程组证据；只允许已记录会话的 running 节点。 */
  async recordWriter(record: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly pgid: number; readonly startedAt: string }): Promise<void> {
    await this.exclusive(async () => {
      const key = controlKey(record.runId, record.nodeId);
      const node = this.#nodes.get(key);
      if (!node || node.agentSessionId !== record.agentSessionId) throw new Error("agent.writer 的 Control 节点或会话身份不匹配。");
      if (!this.#recordedSessions.has(key)) throw new Error("agent.writer 必须先有 agent.session 事实。");
      const snapshot = this.state.agent(record.nodeId);
      if ((snapshot.status !== "running" && snapshot.status !== "recovering") || snapshot.agentSessionId !== record.agentSessionId) throw new Error("agent.writer 只能更新当前 running/recovering 节点。");
      const event: JournalEvent = {
        type: "agent.writer", at: new Date().toISOString(), runId: record.runId, nodeId: record.nodeId,
        agentSessionId: record.agentSessionId, diagnostic: null, pgid: record.pgid, startedAt: record.startedAt,
      };
      this.state.assertApplicable(event);
      await this.journal.append(event);
      this.state.apply(event);
    });
  }

  /** 记录 provider 创建意图；started 必须先于 spawn，cancelled 表示确定未创建或已清理。 */
  async recordWriterIntent(record: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string; readonly status: "started" | "cancelled" }): Promise<void> {
    await this.exclusive(async () => {
      const key = controlKey(record.runId, record.nodeId);
      const node = this.#nodes.get(key);
      if (!node || node.agentSessionId !== record.agentSessionId) throw new Error("agent.writerIntent 的 Control 节点或会话身份不匹配。");
      const snapshot = this.state.agent(record.nodeId);
      if (snapshot.agentSessionId !== record.agentSessionId) throw new Error("agent.writerIntent 与当前节点会话身份不一致。");
      if (record.status === "started" && snapshot.status !== "running") throw new Error("agent.writerIntent(started) 只能用于 running 节点。");
      const event: JournalEvent = {
        type: "agent.writerIntent", at: new Date().toISOString(), runId: record.runId, nodeId: record.nodeId,
        agentSessionId: record.agentSessionId, diagnostic: null, status: record.status,
      };
      this.state.assertApplicable(event);
      await this.journal.append(event);
      this.state.apply(event);
    });
  }

  /** 节点当前 attempt 的 agent.session 是否已耐久；执行器仅在 false 时允许启动前回退。 */
  hasRecordedNodeSession(nodeId: string, agentSessionId: string): boolean {    return this.state.hasNodeSession(nodeId, agentSessionId);
  }

  /** 节点已进入终态或 Run 已停止时，启动重试不得再创建新 Worker。 */
  isNodeStopped(nodeId: string): boolean {
    const node = this.state.agent(nodeId);
    return this.state.snapshot().status !== "running" || ["cancelled", "interrupted", "completed"].includes(node.status);
  }

  /** 停滞采样的等待豁免：Run控制转换或原节点非running时不计时；不授权任何操作。 */
  isWorkerWaiting(nodeId: string, agentSessionId: string): boolean {
    const node = this.state.agent(nodeId);
    const key = controlKey(this.runId, nodeId);
    return node.agentSessionId !== agentSessionId || this.state.snapshot().status !== "running" || node.status !== "running"
      || this.#completing.has(key) || Boolean(node.block&&this.#continuing.has(node.block.blockRequestId)) || this.#blocking.has(key);
  }

  /** 原执行器按注册身份读取当前协议事实；互斥区核验会话/Journal/状态，返回副本且零写入。 */
  async workerTurnContext(identity: Pick<RegisteredControlNode,"runId"|"nodeId"|"agentSessionId"|"capability">):Promise<WorkerTurnContext> {
    await this.awaitRecoveryAccepted(identity.nodeId, identity.agentSessionId);
    return this.exclusive(async()=>{
      const key=controlKey(identity.runId,identity.nodeId);
      this.requireCurrentNode(key,identity);
      if(!this.#recordedSessions.has(key))throw new Error("收尾缺少耐久ACP会话绑定。");
      const node=this.state.agent(identity.nodeId);
      if(node.agentSessionId!==identity.agentSessionId||!["running","blocked"].includes(node.status))throw new Error("原节点已终结或会话已变化，拒绝收尾。");
      const block=node.status==="blocked"&&node.block?{blockRequestId:node.block.blockRequestId,needHelp:node.block.needHelp,answerSchema:node.block.answerSchema??null,answer:this.#blocks.answerSnapshot({...identity,blockRequestId:node.block.blockRequestId}),delivery:node.block.delivery??(node.block.answered?"answered":"pending")}:null;
      return structuredClone({status:node.status as "running"|"blocked",resultSchema:node.request.schema??null,block});
    });
  }

  /** 绑定节点的瞬时提示；只更新 UI hint，不进入诊断日志、不改变业务状态。 */
  async recordExecutorHint(message: string, nodeId: string, agentSessionId: string): Promise<void> {
    if (this.state.agent(nodeId).agentSessionId !== agentSessionId) throw new Error("提示会话已过期。");
    const event: JournalEvent = { type: "log.written", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId, agentSessionId, diagnostic: null, message };
    await this.journal.append(event);
    this.state.apply(event);
  }

  /** 执行器诊断耐久写入；可绑定当前节点/会话，缺省Run级，不改变业务状态。 */
  async recordExecutorDiagnostic(message: string, nodeId: string | null = null, agentSessionId: string | null = null): Promise<void> {
    if ((nodeId === null) !== (agentSessionId === null)) throw new Error("诊断节点与会话必须同时提供。");
    if (nodeId !== null && this.state.agent(nodeId).agentSessionId !== agentSessionId) throw new Error("诊断会话已过期。");
    const event: JournalEvent = { type: "log.written", at: new Date().toISOString(), runId: this.journal.manifest.runId, nodeId, agentSessionId, diagnostic: message, message };
    await this.journal.append(event);
    this.state.apply(event);
  }

  /** 校验 capability、Schema 与 durable 写入后，唯一地完成 running 节点。 */
  async complete(request: CompletionSubmission): Promise<void> {
    await this.awaitRecoveryAccepted(request.nodeId, request.agentSessionId);
    const key = controlKey(request.runId, request.nodeId);
    const node = this.#nodes.get(key);
    if (!node || node.agentSessionId !== request.agentSessionId || node.capability !== request.capability) throw new Error("Control capability、Run、节点或会话身份不匹配。");
    if (!this.#recordedSessions.has(key)) throw new Error("首条任务投递的会话坐标尚未耐久记录，拒绝 complete。");
    if (this.#completing.has(key)) throw new Error("该节点正在处理 complete，拒绝并发上报。");
    this.#completing.add(key);
    try {
    await this.exclusive(async () => {
    if (!request.summary.trim()) throw new Error("complete summary 必须非空。");
    const snapshot = this.state.agent(request.nodeId);
    if (snapshot.status !== "running") throw new Error(`complete 只允许当前 running 节点，实际为 ${snapshot.status}。`);
    if (snapshot.agentSessionId !== request.agentSessionId) throw new Error("complete 会话身份与当前节点不匹配。");
    validateSchema(snapshot.request.schema, request.result);
    const resultPath = await this.journal.writeResult(request.nodeId, request.result, request.agentSessionId);
    const validationPath = await this.journal.writeValidation(request.nodeId, snapshot.request.schema ?? {}, request.result, request.agentSessionId);
    const event: JournalEvent = { type: "agent.completed", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId, agentSessionId: request.agentSessionId, diagnostic: request.summary, resultPath, validationPath, result: request.result };
    // 追加前在状态机副本上试算：与 stop/退出的 cancelled 交错时在这里干净拒绝，
    // 绝不让非法转移先落盘再在 apply 时爆炸（那会永久污染档案）。
    this.state.assertApplicable(event);
    await this.journal.append(event);
    this.state.apply(event);
    this.#nodes.delete(key);
    this.#recordedSessions.delete(key);
    this.#blocks.cancelForSession(request.runId, request.nodeId, request.agentSessionId, "节点已完成，原人工请求仅保留 Journal 历史。");
    try { node.onCompleted?.(request.result); } catch {}
    });
    } finally {
      this.#completing.delete(key);
    }
  }

  /**
   * 耐久 block.created 后立即返回交付状态；答案等待由 Worker 的 Elicitation 承担。
   * 同一 block 重接只读取原事实，continue 后也允许取回原答案，绝不创建第二个 block。
   */
  async block(request: BlockSubmission): Promise<BlockStatus> {
    await this.awaitRecoveryAccepted(request.nodeId, request.agentSessionId);
    const key = controlKey(request.runId, request.nodeId);
    return this.exclusive(async () => {
      this.requireCurrentNode(key, request);
      if (!this.#recordedSessions.has(key)) throw new Error("首条任务投递的会话坐标尚未耐久记录，拒绝 block。");
      if (!request.needHelp.trim()) throw new Error("block --need-help 必须非空。");
      const snapshot = this.state.agent(request.nodeId);
      if (this.#blocks.has(request.blockRequestId)) {
        if (snapshot.status !== "blocked" && snapshot.status !== "running") throw new Error(`重接 block 只允许当前 blocked/running 节点，实际为 ${snapshot.status}。`);
        if (snapshot.status === "blocked" && snapshot.block?.blockRequestId !== request.blockRequestId) throw new Error("重接 block 不是该节点当前等待的 block。");
        this.#blocks.assertSameSubmission(request);
        return { ...this.#blocks.status(request, snapshot.block?.delivery), deliveryToken: snapshot.block?.deliveryToken };
      }
      if (snapshot.status !== "running") throw new Error(`block 只允许当前 running 节点，实际为 ${snapshot.status}。`);
      const created = this.#blocks.create(request);
      this.#blocking.add(key);
      try {
        const event: JournalEvent = {
          type: "block.created", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId,
          agentSessionId: request.agentSessionId, diagnostic: request.needHelp, blockRequestId: created.blockRequestId,
          needHelp: request.needHelp, answerSchema: created.answerSchema,
        };
        this.state.assertApplicable(event);
        await this.journal.append(event);
        this.state.apply(event);
      } catch (error) {
        this.#blocks.discard(created.blockRequestId);
        throw error;
      } finally {
        this.#blocking.delete(key);
      }
      return { ...this.#blocks.status(created), deliveryToken: this.state.agent(request.nodeId).block?.deliveryToken };
    });
  }

  /** 人类答案先写 Journal，再唤醒等待同一 block 的 Elicitation；状态仍保持 blocked。 */
  async answer(submission: BlockAnswerSubmission): Promise<void> {
    if (this.#answering.has(submission.blockRequestId)) throw new Error("该 block 正在处理答案，拒绝并发 answer。");
    this.#answering.add(submission.blockRequestId);
    try {
      await this.exclusive(async () => {
        const pending = this.#blocks.validateAnswer(submission);
        this.requireCurrentNode(controlKey(pending.runId, pending.nodeId), pending);
        // continue 后仍允许同会话同值重试幂等成功；首次交付才要求 blocked。
        if (pending.answer) return;
        const snapshot = this.state.agentForBlock(submission.blockRequestId);
        if (snapshot?.status !== "blocked" && snapshot?.status !== "pausing" && snapshot?.status !== "paused" && snapshot?.status !== "recovering") throw new Error("block 所属节点当前不在等待答案状态，拒绝交付。 ");
        if (snapshot.block?.delivery === "closed") throw new Error("block 表单已关闭；请先由用户显式重开再交付答案。 ");
        const event: JournalEvent = {
          type: "block.answered", at: new Date().toISOString(), runId: pending.runId, nodeId: pending.nodeId,
          agentSessionId: pending.agentSessionId, diagnostic: null, blockRequestId: pending.blockRequestId, answer: submission.answer,
        };
        this.state.assertApplicable(event);
        await this.journal.append(event);
        this.state.apply(event);
        // durable-first：只有答案已成为 Journal 事实后，才允许原 Agent 收到它。
        this.#blocks.deliverAnswer(submission.blockRequestId, submission.answer);
      });
    } finally {
      this.#answering.delete(submission.blockRequestId);
    }
  }

  /** 关闭当前表单并唤醒等待者；Worker 私有调用必须同时证明原节点身份，Desktop 按 block 路由。 */
  async closeBlock(blockRequestId: string, identity?: Pick<RegisteredControlNode, "runId" | "nodeId" | "agentSessionId" | "capability">, expectedDeliveryToken?: string): Promise<void> {
    await this.exclusive(async () => {
      const snapshot = this.state.agentForBlock(blockRequestId);
      if (expectedDeliveryToken !== undefined && snapshot?.block?.deliveryToken !== expectedDeliveryToken) return;
      if (identity) {
        this.requireCurrentNode(controlKey(identity.runId, identity.nodeId), identity);
        if (!snapshot || snapshot.id !== identity.nodeId || snapshot.agentSessionId !== identity.agentSessionId || this.runId !== identity.runId) throw new Error("close-block 不属于创建该 block 的原 Agent 会话。 ");
      }
      if (snapshot?.status === "blocked" && snapshot.block?.delivery === "pending") {
        const event: JournalEvent = { type: "block.closed", at: new Date().toISOString(), runId: this.runId, nodeId: snapshot.id, agentSessionId: snapshot.agentSessionId, diagnostic: null, blockRequestId };
        this.state.assertApplicable(event);
        await this.journal.append(event);
        this.state.apply(event);
      }
      // 暂停/恢复中不写新的 closed 事实，但必须取消原等待者，不能依赖 CLI 一定转发 abort。
      if (snapshot?.block?.delivery === "pending") this.#blocks.close(blockRequestId);
    });
  }

  /** 复核 ACP 表单属于当前 Worker 的原 block，并等待既有答案；关闭只返回 cancel。 */
  async waitForBlockAnswer(
    identity: Pick<RegisteredControlNode, "runId" | "nodeId" | "agentSessionId" | "capability">,
    request: WorkerElicitationRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly action: "accept"; readonly content: JsonObject } | { readonly action: "cancel" }> {
    const registration = await this.exclusive(async () => {
      const key = controlKey(identity.runId, identity.nodeId);
      this.requireCurrentNode(key, identity);
      const snapshot = this.state.agent(identity.nodeId);
      if (request.mode !== "form") throw new Error("Wave Flow 只接受 form elicitation。");
      if (snapshot.status !== "blocked" || !snapshot.block) throw new Error("当前节点没有可交付的人工请求。 ");
      const block = snapshot.block;
      const pending = this.#blocks.assertSameSubmission({ ...identity, blockRequestId: block.blockRequestId, needHelp: block.needHelp, answerSchema: block.answerSchema! });
      if (request.message !== pending.needHelp) throw new Error("elicitation 问题与原 block 不一致。 ");
      if (request.blockRequestId !== undefined && request.blockRequestId !== pending.blockRequestId) throw new Error("elicitation 的 blockRequestId 与原 block 不一致。 ");
      const requestedSchema = normalizeHitlAnswerSchema(request.requestedSchema);
      if (!isDeepStrictEqual(requestedSchema, pending.answerSchema)) throw new Error("elicitation Schema 与原 block 不一致。 ");
      if (block.delivery === "closed") return null;
      // 等待注册与 close/answer 共用互斥区，消除“先关闭、后注册”的永久等待窗口。
      return { blockRequestId: pending.blockRequestId, deliveryToken: block.deliveryToken, waiting: this.#blocks.wait(pending.blockRequestId, signal) };
    });
    if (!registration) return { action: "cancel" };
    try {
      const resolution = await registration.waiting;
      return { action: "accept", content: resolution.answer };
    } catch (error) {
      // closeBlock 已经拒绝了原等待者；迟到 catch 不得再关闭用户已重开的新表单。
      if (error instanceof Error && error.message.includes("已关闭")) return { action: "cancel" };
      if (signal?.aborted) {
        // 只允许关闭本次 elicitation 注册时的那一代交付；用户重开后 token 已更换，
        // 迟到的 abort 不能把新表单重新关掉。
        try { await this.closeBlock(registration.blockRequestId, undefined, registration.deliveryToken); } catch { /* 会话已注销时保留取消语义。 */ }
        return { action: "cancel" };
      }
      throw error;
    }
  }

  /** Engine 用于按全局 blockRequestId 路由用户侧 answer；不暴露 pending 内容。 */
  hasBlock(blockRequestId: string): boolean { return this.#blocks.has(blockRequestId); }

  /** 答案交付后释放 block；同会话同 ID 重试只返回成功，不重复写 Journal。 */
  async continue(request: ContinueSubmission): Promise<void> {
    await this.awaitRecoveryAccepted(request.nodeId, request.agentSessionId);
    if (this.#continuing.has(request.blockRequestId)) throw new Error("该 block 正在处理 continue，拒绝并发请求。");
    this.#continuing.add(request.blockRequestId);
    try {
      await this.exclusive(async () => {
        const key = controlKey(request.runId, request.nodeId);
        this.requireCurrentNode(key, request);
        const pending = this.#blocks.assertCanContinue(request);
        if (pending.continued) return;
        const snapshot = this.state.agent(request.nodeId);
        if (snapshot.status !== "blocked") throw new Error(`continue 只允许当前 blocked 节点，实际为 ${snapshot.status}。`);
        const event: JournalEvent = {
          type: "agent.continued", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId,
          agentSessionId: request.agentSessionId, diagnostic: null, blockRequestId: pending.blockRequestId,
        };
        this.state.assertApplicable(event);
        await this.journal.append(event);
        this.state.apply(event);
        this.#blocks.finishContinue(pending.blockRequestId);
      });
    } finally {
      this.#continuing.delete(request.blockRequestId);
    }
  }

  /** 恢复 prompt 可以先于 recovered/running 耐久事实到达 Worker；只在该窗口有界等待，其他状态仍按原规则拒绝。 */
  private async awaitRecoveryAccepted(nodeId: string, agentSessionId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (this.state.agent(nodeId).status === "recovering" && this.state.agent(nodeId).agentSessionId === agentSessionId) {
      if (Date.now() >= deadline) throw new Error("恢复状态尚未确认，拒绝受理 Worker 协议请求。 ");
      await Bun.sleep(1);
    }
  }

  private requireCurrentNode(key: string, request: Pick<BlockSubmission, "runId" | "nodeId" | "agentSessionId" | "capability">): RegisteredControlNode {
    const node = this.#nodes.get(key);
    if (!node || node.agentSessionId !== request.agentSessionId || node.capability !== request.capability) throw new Error("Control capability、Run、节点或会话身份不匹配。");
    return node;
  }

}

function controlKey(runId: string, nodeId: string): string { return `${runId}\0${nodeId}`; }

function validateSchema(schema: JsonSchema | undefined, result: JsonObject): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validator(result)) throw new Error(`complete 结果不符合节点 schema：${new Ajv({ allErrors: true, strict: false }).errorsText(validator.errors)}`);
}
