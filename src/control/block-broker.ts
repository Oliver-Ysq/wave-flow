import Ajv from "ajv";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../shared/json";
import type { JsonSchema } from "../shared/workflow-types";
import { normalizeBlockUserNote, normalizeHitlAnswerSchema } from "../shared/hitl-schema";

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
  /** ACP 与 Desktop 共同支持的扁平人类答案 Schema。 */
  readonly answerSchema: JsonSchema;
};

/** block.created 已耐久后的即时状态；答案尚未到达时为 null。 */
export type BlockStatus = {
  /** 稳定 block 请求 id。 */
  readonly blockRequestId: string;
  /** 规范化后的答案 Schema，供 MCP Elicitation 原样使用。 */
  readonly answerSchema: JsonSchema;
  /** 已耐久的答案；未回答时为 null，严格符合 answerSchema。 */
  readonly answer: JsonObject | null;
  /** 已耐久的可选用户补充意见；未提供时为 null，不进入 ACP accept content。 */
  readonly userNote: string | null;
  /** 当前交付状态；closed 只能由用户显式重开，Worker 重接不得撤销。 */
  readonly delivery: "pending" | "answered" | "closed" | "delivered";
  /** 当前交付代际；close-block 必须携带，迟到代际必须被忽略。 */
  readonly deliveryToken?: string;
};

/** 人类向一个 pending block 提交的 JSON 对象答案与可选补充意见。 */
export type BlockAnswerSubmission = {
  /** 稳定 block 请求 id。 */
  readonly blockRequestId: string;
  /** 人类提供的 JSON 对象。 */
  readonly answer: JsonObject;
  /** 可选补充意见；提交时去首尾空白，空串归一为缺省，最长 4000 字。 */
  readonly userNote?: string;
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

/** 原 Agent 从 block 命令获得的答案、可选意见与其稳定请求 id。 */
export type BlockResolution = {
  /** 后续 continue 必须携带的同一 block id。 */
  readonly blockRequestId: string;
  /** 已耐久交付的人类 JSON 答案。 */
  readonly answer: JsonObject;
  /** 已耐久交付的可选补充意见；未提供时为 null。 */
  readonly userNote: string | null;
};

/** 同一 Engine 生命周期内的 pending block 与原 Agent 等待者。 */
export class BlockBroker {
  #pending = new Map<string, PendingBlock>();

  /** 创建 pending block；同一 request id 不能覆盖现有等待者。 */
  create(submission: BlockSubmission): PendingBlock {
    if (!/^[0-9a-f-]{36}$/i.test(submission.blockRequestId)) throw new Error("blockRequestId 必须是 UUID。");
    if (this.#pending.has(submission.blockRequestId)) throw new Error("同一 blockRequestId 已在等待中。");
    const answerSchema = normalizeHitlAnswerSchema(submission.answerSchema);
    const pending: PendingBlock = { ...submission, answerSchema, answer: null, userNote: null, continued: false, waiters: [] };
    this.#pending.set(submission.blockRequestId, pending);
    return pending;
  }

  /** 从 Journal 重建一个已经 durable 的 block；不得再次写 block.created。 */
  restore(submission: BlockSubmission, answer: JsonObject | null, userNote?: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(submission.blockRequestId)) throw new Error("blockRequestId 必须是 UUID。");
    if (this.#pending.has(submission.blockRequestId)) throw new Error("同一 blockRequestId 已恢复。");
    const answerSchema = normalizeHitlAnswerSchema(submission.answerSchema);
    if (answer) validateAnswer(answerSchema, answer);
    const normalizedNote = normalizeBlockUserNote(userNote) ?? null;
    if (!answer && normalizedNote) throw new Error("没有答案时不能恢复单独的用户意见。");
    this.#pending.set(submission.blockRequestId, { ...submission, answerSchema, answer, userNote: normalizedNote, continued: false, waiters: [] });
  }

  /** 验证重接请求恰好对应 Journal 中的同一个 block，而非创建第二个 block。 */
  assertSameSubmission(submission: BlockSubmission): PendingBlock {
    const pending = this.require(submission.blockRequestId);
    const answerSchema = normalizeHitlAnswerSchema(submission.answerSchema);
    // JSON对象键序不是请求内容；模型/CLI序列化重排键不应变成另一个请求，数组顺序与值仍严格一致。
    if (pending.runId !== submission.runId || pending.nodeId !== submission.nodeId || pending.agentSessionId !== submission.agentSessionId || pending.capability !== submission.capability || pending.needHelp !== submission.needHelp || !isDeepStrictEqual(pending.answerSchema, answerSchema)) throw new Error("重接 block 与 Journal 中原请求不一致。");
    return pending;
  }

  /** 当前 block 的即时交付状态；continue 后仍允许读取原答案与意见。 */
  status(submission: BlockSubmission, delivery?: BlockStatus["delivery"]): BlockStatus {
    const pending = this.assertSameSubmission(submission);
    return { blockRequestId: pending.blockRequestId, answerSchema: pending.answerSchema, answer: pending.answer ? structuredClone(pending.answer) : null, userNote: pending.userNote, delivery: delivery ?? (pending.continued ? "delivered" : pending.answer ? "answered" : "pending") };
  }

  /** 等待人类答案；信号关闭只取消当前等待者，不改变 block、答案或意见事实。 */
  wait(blockRequestId: string, signal?: AbortSignal): Promise<BlockResolution> {
    const pending = this.require(blockRequestId);
    if (pending.answer) return Promise.resolve({ blockRequestId, answer: pending.answer, userNote: pending.userNote });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.waiters = pending.waiters.filter(candidate => candidate !== waiter);
        waiter.reject(new Error("elicitation 等待已取消。"));
      };
      const waiter = {
        resolve: (resolution: BlockResolution) => { signal?.removeEventListener("abort", onAbort); resolve(resolution); },
        reject: (error: Error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      };
      if (signal?.aborted) { onAbort(); return; }
      pending.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 校验答案与意见；同 ID 同值幂等，任一冲突都拒绝覆盖。 */
  validateAnswer(submission: BlockAnswerSubmission): PendingBlock {
    const pending = this.require(submission.blockRequestId);
    const userNote = normalizeBlockUserNote(submission.userNote) ?? null;
    if (pending.answer) {
      if (isDeepStrictEqual(pending.answer, submission.answer) && pending.userNote === userNote) return pending;
      throw new Error("该 block 已有不同答案或用户意见，拒绝覆盖。");
    }
    validateAnswer(pending.answerSchema, submission.answer);
    return pending;
  }

  /** Journal 已落盘后才向原等待者交付答案；会话已注销时耐久事实优先，清理不得反推失败。 */
  deliverAnswer(blockRequestId: string, answer: JsonObject, userNote?: string): void {
    const pending = this.#pending.get(blockRequestId);
    if (!pending) return;
    if (pending.answer) throw new Error("该 block 已有答案，拒绝覆盖。");
    const normalizedNote = normalizeBlockUserNote(userNote) ?? null;
    pending.answer = answer;
    pending.userNote = normalizedNote;
    const waiters = pending.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ blockRequestId, answer, userNote: normalizedNote });
  }

  /** 关闭当前等待者但不删除 block；会话已注销时耐久关闭事实同样优先。 */
  close(blockRequestId: string): void {
    const pending = this.#pending.get(blockRequestId);
    if (!pending) return;
    const waiters = pending.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(new Error("elicitation 已关闭，可重新打开原 block。"));
  }

  /** continue 只允许原会话在已回答的 pending block 上调用。 */
  assertCanContinue(submission: ContinueSubmission): PendingBlock {
    const pending = this.require(submission.blockRequestId);
    if (!pending.answer) throw new Error("block 尚未收到人类答案，不能 continue。");
    if (pending.runId !== submission.runId || pending.nodeId !== submission.nodeId || pending.agentSessionId !== submission.agentSessionId || pending.capability !== submission.capability) throw new Error("continue 不属于创建该 block 的原 Agent 会话。");
    return pending;
  }

  /** continue 后保留耐久历史，允许同会话按原 ID 重读答案且永不创建第二个 block。 */
  finishContinue(blockRequestId: string): void {
    const pending = this.require(blockRequestId);
    pending.continued = true;
  }

  /** 会话不可继续验证时拒绝原等待者，避免 block HTTP 永久悬挂。 */
  cancelForSession(runId: string, nodeId: string, agentSessionId: string, reason: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.runId !== runId || pending.nodeId !== nodeId || pending.agentSessionId !== agentSessionId) continue;
      this.#pending.delete(id);
      const waiters = pending.waiters.splice(0);
      for (const waiter of waiters) waiter.reject(new Error(reason));
    }
  }

  has(blockRequestId: string): boolean { return this.#pending.has(blockRequestId); }
  /** 已绑定原会话的只读收尾读取；不交付答案或唤醒等待者，返回答案与意见副本。 */
  answerSnapshot(identity: ContinueSubmission): { readonly answer: JsonObject; readonly userNote: string | null } | null {
    const pending=this.require(identity.blockRequestId);
    if(pending.runId!==identity.runId||pending.nodeId!==identity.nodeId||pending.agentSessionId!==identity.agentSessionId||pending.capability!==identity.capability)throw new Error("收尾人工请求不属于原会话。");
    return pending.answer ? { answer: structuredClone(pending.answer), userNote: pending.userNote } : null;
  }
  /** Journal 写入失败时撤销尚未对 Agent 可见的 pending block。 */
  discard(blockRequestId: string): void { this.#pending.delete(blockRequestId); }
  private require(blockRequestId: string): PendingBlock {
    const pending = this.#pending.get(blockRequestId);
    if (!pending) throw new Error("指定 block 不存在或不属于当前 Engine 生命周期。");
    return pending;
  }
}

type PendingBlock = BlockSubmission & {
  readonly blockRequestId: string;
  answer: JsonObject | null;
  /** 已耐久的可选用户意见；与答案一起幂等重读。 */
  userNote: string | null;
  /** 答案已交付并释放后仍保留历史，供同会话幂等重读。 */
  continued: boolean;
  waiters: { resolve: (resolution: BlockResolution) => void; reject: (error: Error) => void }[];
};

function validateAnswer(schema: JsonSchema | undefined, answer: JsonObject): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validator(answer)) throw new Error(`block 答案不符合 answer-schema：${new Ajv({ allErrors: true, strict: false }).errorsText(validator.errors)}`);
}
