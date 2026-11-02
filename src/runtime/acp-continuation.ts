import { AcpAmbiguousPromptError } from "../adapters/acp-session";

/**
 * 续用回合的固定指令。
 *
 * 只陈述宿主能证明的事实（上一回合被中断、旧进程已核验），并要求模型先核对再继续；
 * 绝不重发原始业务任务——那会让模型从头重做，可能重复已发生的副作用。
 */
export function acpContinuationPrompt(): string {
  return "上一回合被中断，宿主已核验旧进程并重新接上这条会话。继续前先核对最近一次动作是否真的完成，已完成或已生效的不要重复执行；需要重做的动作先检查现场，然后继续完成任务。";
}

/**
 * 一次续用投递的结论。
 *
 * `unknown` 表示 prompt 可能已经写入连接但没有拿到响应：节点必须按投递不确定处理，
 * 禁止自动重发；`refused` 表示协议层明确拒绝，同样只上报，不自动换会话重试。
 */
export type AcpContinuationOutcome =
  | { readonly outcome: "continued"; readonly stopReason: string }
  | { readonly outcome: "unknown"; readonly reason: string }
  | { readonly outcome: "refused"; readonly reason: string };

/** 把续用回合的异常分类；只有“投递结果不确定”允许继续等待，其他都算拒绝。 */
export function classifyContinuationFailure(error: unknown): AcpContinuationOutcome {
  if (error instanceof AcpAmbiguousPromptError) {
    return { outcome: "unknown", reason: error.message };
  }
  return { outcome: "refused", reason: error instanceof Error ? error.message : String(error) };
}
