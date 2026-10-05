import Ajv from "ajv";
import type { RunJournal } from "../journal/run-journal";
import type { JournalEvent } from "../journal/types";
import type { RunStateMachine } from "../runtime/run-state-machine";
import type { JsonObject } from "../shared/json";
import type { JsonSchema } from "../shared/workflow-types";
import type { SessionIdentity } from "../sessions/types";
import { BlockBroker, type BlockAnswerSubmission, type BlockResolution, type BlockSubmission, type ContinueSubmission } from "./block-broker";

export type { BlockAnswerSubmission, BlockResolution, BlockSubmission, ContinueSubmission } from "./block-broker";

/** 注册后仅在当前 daemon 生命周期有效的节点 capability。 */
export type RegisteredControlNode = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 真实 Agent 会话身份；为空时节点尚未接入受管 Control。 */
  readonly agentSessionId: string;
  /** 仅注入受管 Agent 会话环境的高熵 capability。 */
  readonly capability: string;
  /** 节点完成后通知对应真实执行器返回结果；仅 daemon 内部使用，异常不得回滚已完成状态。 */
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

/**
 * @deprecated 请使用 CompletionSubmission。
 * 保留该别名避免已有 Adapter 在完成协议改名时失去编译兼容；运行时语义完全相同。
 */
export type CompleteRequest = CompletionSubmission;

/** 已确认首条任务投递后的会话记录；只有它耐久后才允许 complete。 */
export type RecordedAgentSession = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 与当前 running 节点一致的会话身份。 */
  readonly agentSessionId: string;
  /** Session Host 返回的稳定会话坐标。 */
  readonly session: SessionIdentity;
  /** 首条任务的实际投递方式。 */
  readonly delivery: "tmux" | "codex-rpc";
  /** App Server hybrid 的官方 thread/turn 坐标。 */
  readonly appServer?: { readonly endpoint: string; readonly threadId: string; readonly turnId: string; };
};

/** Control Server 的最小 complete 协议。 */
export class ControlServer {
  #nodes = new Map<string, RegisteredControlNode>();
  #completing = new Set<string>();
  #recordedSessions = new Set<string>();
  #blocks = new BlockBroker();
  #answering = new Set<string>();
  #continuing = new Set<string>();

  constructor(private readonly journal: RunJournal, private readonly state: RunStateMachine) {}

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

  /** 启动失败时撤销尚未完成的 capability；已完成节点不会被撤销。 */
  unregister(runId: string, nodeId: string, agentSessionId: string): void {
    const key = controlKey(runId, nodeId);
    const node = this.#nodes.get(key);
    if (node?.agentSessionId === agentSessionId) {
      this.#blocks.cancelForSession(runId, nodeId, agentSessionId, "原 Agent 会话已结束，无法继续等待人工答案。");
      this.#nodes.delete(key);
      this.#recordedSessions.delete(key);
    }
  }

  /** 耐久记录已投递任务的会话坐标，避免 complete 指向不可恢复或错误的终端。 */
  async recordSession(record: RecordedAgentSession): Promise<void> {
    const key = controlKey(record.runId, record.nodeId);
    const node = this.#nodes.get(key);
    if (!node || node.agentSessionId !== record.agentSessionId) throw new Error("会话记录的 Control 节点或会话身份不匹配。");
    if (this.#recordedSessions.has(key)) throw new Error("该节点的会话坐标已记录。");
    const snapshot = this.state.agent(record.nodeId);
    if (snapshot.status !== "running" || snapshot.agentSessionId !== record.agentSessionId) throw new Error("只能记录当前 running 节点的会话坐标。");
    if (record.session.runId !== record.runId || record.session.nodeId !== record.nodeId || record.session.agentSessionId !== record.agentSessionId || record.session.cli !== snapshot.cli) throw new Error("会话坐标与当前节点身份不匹配。");
    if (record.delivery === "tmux" && record.appServer !== undefined) throw new Error("普通 tmux 投递不得记录 App Server 坐标。");
    if (record.delivery === "codex-rpc" && (!record.appServer || !record.appServer.endpoint || !record.appServer.threadId || !record.appServer.turnId)) throw new Error("App Server 投递缺少 thread/turn 坐标。");
    const event: JournalEvent = {
      type: "agent.session", at: new Date().toISOString(), runId: record.runId, nodeId: record.nodeId,
      agentSessionId: record.agentSessionId, diagnostic: record.delivery,
      delivery: record.delivery, session: record.session,
      ...(record.appServer ? { appServer: { ...record.appServer, protocolVersion: 1 as const } } : {}),
    };
    await this.journal.append(event);
    this.state.apply(event);
    this.#recordedSessions.add(key);
  }

  /** 校验 capability、Schema 与 durable 写入后，唯一地完成 running 节点。 */
  async complete(request: CompletionSubmission): Promise<void> {
    const key = controlKey(request.runId, request.nodeId);
    const node = this.#nodes.get(key);
    if (!node || node.agentSessionId !== request.agentSessionId || node.capability !== request.capability) throw new Error("Control capability、Run、节点或会话身份不匹配。");
    if (!this.#recordedSessions.has(key)) throw new Error("首条任务投递的会话坐标尚未耐久记录，拒绝 complete。");
    if (this.#completing.has(key)) throw new Error("该节点正在处理 complete，拒绝并发上报。");
    this.#completing.add(key);
    try {
    if (!request.summary.trim()) throw new Error("complete summary 必须非空。");
    const snapshot = this.state.agent(request.nodeId);
    if (snapshot.status !== "running") throw new Error(`complete 只允许当前 running 节点，实际为 ${snapshot.status}。`);
    if (snapshot.agentSessionId !== request.agentSessionId) throw new Error("complete 会话身份与当前节点不匹配。");
    validateSchema(snapshot.request.schema, request.result);
    const resultPath = await this.journal.writeResult(request.nodeId, request.result);
    const validationPath = await this.journal.writeValidation(request.nodeId, snapshot.request.schema ?? {}, request.result);
    const event: JournalEvent = { type: "agent.completed", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId, agentSessionId: request.agentSessionId, diagnostic: request.summary, resultPath, validationPath, result: request.result };
    await this.journal.append(event);
    this.state.apply(event);
    this.#nodes.delete(key);
    try { node.onCompleted?.(request.result); } catch {}
    } finally {
      this.#completing.delete(key);
    }
  }

  /**
   * 让原 Agent 调用等待人类答案；状态先 durable 变为 blocked，答案不会直接恢复节点。
   */
  async block(request: BlockSubmission): Promise<BlockResolution> {
    const key = controlKey(request.runId, request.nodeId);
    this.requireCurrentNode(key, request);
    if (!this.#recordedSessions.has(key)) throw new Error("首条任务投递的会话坐标尚未耐久记录，拒绝 block。");
    if (!request.needHelp.trim()) throw new Error("block --need-help 必须非空。");
    const snapshot = this.state.agent(request.nodeId);
    if (snapshot.status !== "running") throw new Error(`block 只允许当前 running 节点，实际为 ${snapshot.status}。`);
    const pending = this.#blocks.create(request);
    try {
      const event: JournalEvent = {
        type: "block.created", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId,
        agentSessionId: request.agentSessionId, diagnostic: request.needHelp, blockRequestId: pending.blockRequestId,
        needHelp: request.needHelp, ...(request.answerSchema ? { answerSchema: request.answerSchema } : {}),
      };
      await this.journal.append(event);
      this.state.apply(event);
    } catch (error) {
      this.#blocks.discard(pending.blockRequestId);
      throw error;
    }
    // 只有 Journal 已经证明节点 blocked 后，原 Agent 才可开始等待答案。
    return this.#blocks.wait(pending.blockRequestId);
  }

  /** 人类答案先写 Journal，再精确唤醒创建该 block 的原调用；状态仍保持 blocked。 */
  async answer(submission: BlockAnswerSubmission): Promise<void> {
    if (this.#answering.has(submission.blockRequestId)) throw new Error("该 block 正在处理答案，拒绝并发 answer。");
    this.#answering.add(submission.blockRequestId);
    try {
    const pending = this.#blocks.validateAnswer(submission);
    const event: JournalEvent = {
      type: "block.answered", at: new Date().toISOString(), runId: pending.runId, nodeId: pending.nodeId,
      agentSessionId: pending.agentSessionId, diagnostic: null, blockRequestId: pending.blockRequestId, answer: submission.answer,
    };
    await this.journal.append(event);
    this.state.apply(event);
    // durable-first：只有答案已成为 Journal 事实后，才允许原 Agent 收到它。
    this.#blocks.deliverAnswer(submission.blockRequestId, submission.answer);
    } finally {
      this.#answering.delete(submission.blockRequestId);
    }
  }

  /** daemon 用于按全局 blockRequestId 路由用户侧 answer；不暴露 pending 内容。 */
  hasBlock(blockRequestId: string): boolean { return this.#blocks.has(blockRequestId); }

  /** 只有原 Agent 在收到答案并自行判断可继续后，才推进 blocked → running。 */
  async continue(request: ContinueSubmission): Promise<void> {
    if (this.#continuing.has(request.blockRequestId)) throw new Error("该 block 正在处理 continue，拒绝并发请求。");
    this.#continuing.add(request.blockRequestId);
    try {
    const key = controlKey(request.runId, request.nodeId);
    this.requireCurrentNode(key, request);
    const snapshot = this.state.agent(request.nodeId);
    if (snapshot.status !== "blocked") throw new Error(`continue 只允许当前 blocked 节点，实际为 ${snapshot.status}。`);
    const pending = this.#blocks.assertCanContinue(request);
    const event: JournalEvent = {
      type: "agent.continued", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId,
      agentSessionId: request.agentSessionId, diagnostic: null, blockRequestId: pending.blockRequestId,
    };
    await this.journal.append(event);
    this.state.apply(event);
    this.#blocks.finishContinue(pending.blockRequestId);
    } finally {
      this.#continuing.delete(request.blockRequestId);
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
