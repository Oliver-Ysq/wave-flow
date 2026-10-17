import type { HarnessActionCallbacks } from "./action-tools";
import { HARNESS_ACTION_TOOL_NAMES } from "./action-tools";
import type { HarnessSession } from "./session";

/**
 * 历史测试夹具的最小别名。Pi/OpenAI-compatible 主控实现已移除；生产仅使用
 * ACP HarnessSession。此别名不提供模型、网络或凭据配置。
 */
export type HarnessPiSession = HarnessSession;

/** Harness MCP 的工具白名单，保留给契约测试使用。 */
export function isHarnessToolAllowed(name: string, hasActions: boolean): boolean {
  return hasActions && (HARNESS_ACTION_TOOL_NAMES as readonly string[]).includes(name);
}
