import Ajv from "ajv";
import type { JsonObject } from "../shared/json";
import type { JsonSchema } from "../shared/workflow-types";

/** Block 创建提交；只允许当前受管 Agent 请求人工协助。 */
export type BlockSubmission = {
  /** Agent 本地生成的 UUID；命令开始等待前即可打印给终端用户。 */
  readonly blockRequestId: string;
  /** 所属 Run。 */
  readonly runId: string;
  /** 当前 blocked 节点。 */
  readonly nodeId: string;
  /** 当前 Agent 会话身份。 */
  readonly agentSessionId: string;
  /** 仅注入受管会话环境的 capability。 */
  readonly capability: string;
  /** Agent 为何无法安全继续、希望人如何帮助的完整说明。 */
  readonly needHelp: string;
  /** 可选的人类答案 JSON Schema。 */
  readonly answerSchema?: JsonSchema;
};

/** 人类向一个 pending block 提交的 JSON 对象答案。 */
export type BlockAnswerSubmission = {
  /** 稳定 block 请求 id。 */
  readonly blockRequestId: string;
  /** 人类提供的 JSON 对象。 */
  readonly answer: JsonObject;
};

/** 原 Agent 收到答案后请求恢复的身份信息。 */
export type ContinueSubmission = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 当前节点。 */
  readonly nodeId: string;
  /** 当前 Agent 会话。 */
  readonly agentSessionId: string;
  /** 受管会话 capability。 */
  readonly capability: string;
  /** 当前等待的 block 请求 id。 */
  readonly blockRequestId: string;
};

/** 原 Agent 从 block 命令获得的答案与其稳定请求 id。 */
export type BlockResolution = {
  /** 后续 continue 必须携带的同一 block id。 */
  readonly blockRequestId: string;
  /** 已耐久交付的人类 JSON 答案。 */
  readonly answer: JsonObject;
};

/** 同一 daemon 生命周期内的 pending block 与原 Agent 等待者。 */
export class BlockBroker {
  #pending = new Map<string, PendingBlock>();

  /** 创建 pending block；同一 request id 不能覆盖现有等待者。 */
  create(submission: BlockSubmission): PendingBlock {
    if (!/^[0-9a-f-]{36}$/i.test(submission.blockRequestId)) throw new Error("blockRequestId 必须是 UUID。");
    if (this.#pending.has(submission.blockRequestId)) throw new Error("同一 blockRequestId 已在等待中。");
    if (submission.answerSchema) new Ajv({ allErrors: true, strict: false }).compile(submission.answerSchema);
    const pending: PendingBlock = { ...submission, answer: null, resolve: null, reject: null };
    this.#pending.set(submission.blockRequestId, pending);
    return pending;
  }

  /**
   * 从 Journal 重建一个已经 durable 的 block；不得再次写 block.created。
   * 仅 daemon 重启后的 Control 恢复路径使用，恢复后仍必须由原会话携带
   * daemon 仍会在恢复前核验真实会话，重连者才能取得答案或调用 continue。
   */
  restore(submission: BlockSubmission, answer: JsonObject | null): void {
    if (!/^[0-9a-f-]{36}$/i.test(submission.blockRequestId)) throw new Error("blockRequestId 必须是 UUID。");
    if (this.#pending.has(submission.blockRequestId)) throw new Error("同一 blockRequestId 已恢复。");
    if (submission.answerSchema) new Ajv({ allErrors: true, strict: false }).compile(submission.answerSchema);
    if (answer) validateAnswer(submission.answerSchema, answer);
    this.#pending.set(submission.blockRequestId, { ...submission, answer, resolve: null, reject: null });
  }

  /** 验证重连请求恰好对应 Journal 中的同一个 block，而非创建第二个 block。 */
  assertSameSubmission(submission: BlockSubmission): PendingBlock {
    const pending = this.require(submission.blockRequestId);
    if (pending.runId !== submission.runId || pending.nodeId !== submission.nodeId || pending.agentSessionId !== submission.agentSessionId || pending.capability !== submission.capability || pending.needHelp !== submission.needHelp || JSON.stringify(pending.answerSchema ?? null) !== JSON.stringify(submission.answerSchema ?? null)) throw new Error("重连 block 与 Journal 中原请求不一致。");
    return pending;
  }

  /** 原 block HTTP 调用等待人类答案；答案先到时立即返回。 */
  wait(blockRequestId: string): Promise<BlockResolution> {
    const pending = this.require(blockRequestId);
    if (pending.answer) return Promise.resolve({ blockRequestId, answer: pending.answer });
    if (pending.resolve) throw new Error("同一 block 只能有一个原 Agent 等待者。");
    return new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
  }

  /** 校验答案，但尚不交付；调用方必须先将答案耐久写入 Journal。 */
  validateAnswer(submission: BlockAnswerSubmission): PendingBlock {
    const pending = this.require(submission.blockRequestId);
    if (pending.answer) throw new Error("该 block 已有答案，拒绝覆盖。");
    validateAnswer(pending.answerSchema, submission.answer);
    return pending;
  }

  /** Journal 已落盘后才向原等待者交付答案；不改变 blocked 状态。 */
  deliverAnswer(blockRequestId: string, answer: JsonObject): PendingBlock {
    const pending = this.require(blockRequestId);
    if (pending.answer) throw new Error("该 block 已有答案，拒绝覆盖。");
    pending.answer = answer;
    pending.resolve?.({ blockRequestId, answer });
    pending.resolve = null;
    pending.reject = null;
    return pending;
  }

  /** continue 只允许原会话在已回答的 pending block 上调用。 */
  assertCanContinue(submission: ContinueSubmission): PendingBlock {
    const pending = this.require(submission.blockRequestId);
    if (!pending.answer) throw new Error("block 尚未收到人类答案，不能 continue。");
    if (pending.runId !== submission.runId || pending.nodeId !== submission.nodeId || pending.agentSessionId !== submission.agentSessionId || pending.capability !== submission.capability) throw new Error("continue 不属于创建该 block 的原 Agent 会话。");
    return pending;
  }

  /** continue 事实已落盘后删除 pending，防止 Journal 失败丢失待处理 block。 */
  finishContinue(blockRequestId: string): void { this.#pending.delete(blockRequestId); }

  /** 会话不可继续验证时拒绝原等待者，避免 block HTTP 永久悬挂。 */
  cancelForSession(runId: string, nodeId: string, agentSessionId: string, reason: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.runId !== runId || pending.nodeId !== nodeId || pending.agentSessionId !== agentSessionId) continue;
      this.#pending.delete(id);
      pending.reject?.(new Error(reason));
    }
  }

  has(blockRequestId: string): boolean { return this.#pending.has(blockRequestId); }
  /** Journal 写入失败时撤销尚未对 Agent 可见的 pending block。 */
  discard(blockRequestId: string): void { this.#pending.delete(blockRequestId); }
  private require(blockRequestId: string): PendingBlock {
    const pending = this.#pending.get(blockRequestId);
    if (!pending) throw new Error("指定 block 不存在或不属于当前 daemon 生命周期。");
    return pending;
  }
}

type PendingBlock = BlockSubmission & {
  readonly blockRequestId: string;
  answer: JsonObject | null;
  resolve: ((resolution: BlockResolution) => void) | null;
  reject: ((error: Error) => void) | null;
};

function validateAnswer(schema: JsonSchema | undefined, answer: JsonObject): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validator(answer)) throw new Error(`block 答案不符合 answer-schema：${new Ajv({ allErrors: true, strict: false }).errorsText(validator.errors)}`);
}
