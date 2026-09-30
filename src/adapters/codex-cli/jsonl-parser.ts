import type { CodexJsonEvent } from "./types";

/**
 * 从 Codex JSONL 中提取最后一条 Agent 最终消息。
 *
 * @param jsonl Codex `--json` 的完整 stdout；允许空行，拒绝任何非空的非法 JSON 行。
 * @returns 最后一条 `item.completed` / `agent_message` 的 text；若不存在则为 undefined。
 * @throws stdout 存在无法解析的非空 JSONL 行时抛出。
 */
export function extractFinalAgentMessage(jsonl: string): string | undefined {
  let finalMessage: string | undefined;

  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    finalMessage = extractAgentMessageFromLine(line) ?? finalMessage;
  }

  return finalMessage;
}

/**
 * 解析单行 Codex JSONL，并在该行是最终 Agent 消息时返回文本。
 * @param line 一行非空 stdout JSONL。
 * @returns agent_message 文本；其他合法事件返回 undefined。
 * @throws line 不是合法 JSON 时抛出。
 */
export function extractAgentMessageFromLine(line: string): string | undefined {
  let event: CodexJsonEvent;
  try {
    event = JSON.parse(line) as CodexJsonEvent;
  } catch {
    throw new Error("Codex stdout 包含无法解析的 JSONL 事件。");
  }
  return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string"
    ? event.item.text
    : undefined;
}
