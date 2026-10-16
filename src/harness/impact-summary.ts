import { createHash } from "node:crypto";
import type { HarnessSnapshot } from "./types";

/** 绑定原终态事件，不依赖当前时间或重试次数。 */
export function impactSummaryKey(taskId: string, executionId: string, attempt: number, at: string): string {
  return createHash("sha256").update(JSON.stringify([taskId, executionId, attempt, at])).digest("hex");
}

/** 直接 IPC/服务硬门禁；浏览、反馈、pause/recover 不调用此门。 */
export function assertImpactSummariesComplete(snapshot: HarnessSnapshot): void {
  if (snapshot.impactSummaries?.some(item => item.status !== "completed")) throw new Error("影响面总结尚未完整保存；请先完成或重试影响面总结，再启动或恢复执行。");
}

/** 历史内容只作为数据；遮蔽已知凭据，限制整个响应 UTF-8 字节，默认 48KiB。 */
export function boundedEvidence(value: unknown, maxBytes = 48 * 1024): BoundedEvidence {
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>48*1024)throw new Error("证据字节上限必须为1至48KiB的整数。");
  const raw = JSON.stringify(value).replace(/("(?:api[_-]?key|token|password|secret|authorization|capability)"\s*:\s*)"[^"\\]*(?:\\.[^"\\]*)*"/gi, '$1"[REDACTED]"').replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[\w.\/-]+)/gi, "[REDACTED]");
  const bytes = Buffer.from(raw);
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  if (bytes.length > maxBytes) text = text.replace(/\uFFFD$/, "");
  return { text, truncated: bytes.length > maxBytes, redacted: true };
}

/** 只读限长证据包，不是可执行指令或完整原档案。 */
export type BoundedEvidence={
  /** 脱敏JSON数据片段；truncated=true时不可假装可完整解析。 */
  readonly text:string;
  /** 超过整个响应字节预算；必须向用户/主控说明未覆盖。 */
  readonly truncated:boolean;
  /** 已应用已知凭据规则，恒true；不保证识别所有未知秘密。 */
  readonly redacted:true;
};
