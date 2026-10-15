import { createHash } from "node:crypto";
import type { HarnessSnapshot, WorkflowRevision } from "./types";

/** 用户明确提交的自动编排任务。 */
export type TaskCreation = {
  /** 客户端 UUID；重试保持不变。 */
  readonly clientRequestId: string;
  /** 已验证项目身份。 */
  readonly projectId: string;
  /** 初始目标，1–20000 字符。 */
  readonly text: string;
  /** 固定单行标题，1–120 字符；缺省截断目标首行。 */
  readonly title?: string;
};
/** 创建事实；hash 用于冲突检测，不作为授权。 */
export type TaskMetadata = {
  /** 重试身份。 */
  readonly clientRequestId: string;
  /** 规范化 payload 的 SHA-256。 */
  readonly payloadHash: string;
  /** 固定标题。 */
  readonly title: string;
  /** 初始目标。 */
  readonly initialGoal: string;
};
/** 请求派生的 RFC UUID；稳定身份不是秘密，也不替代 Engine 授权。 */
export function taskIdForRequest(requestId: string): string {
  const digest = createHash("sha256").update(`wave-flow-task:${requestId}`).digest("hex");
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
}
/** 验证并规范化创建，不接受未来来源占位字段。 */
export function normalizeTaskCreation(raw: TaskCreation): TaskCreation & { title: string; payloadHash: string } {
  if (!raw || typeof raw !== "object" || Object.keys(raw).some(key => !["clientRequestId", "projectId", "text", "title"].includes(key))) throw new Error("任务创建字段无效。");
  if (typeof raw.clientRequestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw.clientRequestId)) throw new Error("任务请求标识必须是 UUID。");
  if (typeof raw.projectId !== "string" || !raw.projectId.trim() || typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 20000) throw new Error("任务项目或目标无效。");
  const text = raw.text.trim();
  const title = raw.title === undefined ? Array.from(text.split(/\r?\n/)[0]).slice(0, 120).join("") : raw.title;
  if (typeof title !== "string" || !title.trim() || /[\r\n]/.test(title) || Array.from(title.trim()).length > 120) throw new Error("任务标题必须为 1–120 个单行字符。");
  const value = { clientRequestId: raw.clientRequestId.toLowerCase(), projectId: raw.projectId, text, title: title.trim() };
  return { ...value, payloadHash: createHash("sha256").update(JSON.stringify({ projectId: value.projectId, text: value.text, title: value.title })).digest("hex") };
}
/** 最新未执行且未放弃的候选；拒绝版本仍允许同卡修改。 */
export function candidateRevision(snapshot: HarnessSnapshot): WorkflowRevision | undefined {
  const revision = [...snapshot.workflowRevisions].reverse().find(item => item.cardId && !item.abandonedAt);
  if (!revision || snapshot.executions.some(item => item.revision === revision.revision)) return undefined;
  return revision;
}
/** 新启动资格；resume 不调用此门。 */
export function assertStartable(snapshot: HarnessSnapshot, revisionNumber: number): WorkflowRevision {
  if (snapshot.status !== "idle") throw new Error("主控必须空闲且任务未归档，才能配置或启动工作流。");
  const revision = snapshot.workflowRevisions.find(item => item.revision === revisionNumber);
  if (snapshot.task) {
    if (snapshot.executions.length) throw new Error("多轮工作流尚未开放；可以查看或恢复原执行。");
    if (!revision?.cardId || candidateRevision(snapshot)?.revision !== revisionNumber || revision.abandonedAt) throw new Error("方案已被取代或放弃，不能启动。");
  }
  if (!revision || revision.acceptedAt === null || revision.rejectedAt) throw new Error("只有已接受且未拒绝的当前方案才能启动。");
  if (snapshot.executions.some(item => item.finishedAt === null)) throw new Error("已有未终结工作流，暂停或等待仍占用执行名额。");
  return revision;
}
