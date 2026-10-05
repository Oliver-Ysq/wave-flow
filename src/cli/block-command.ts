import { isJsonObject, type JsonObject } from "../shared/json";
import type { BlockResolution } from "../control/control-server";

/** Agent 发起业务型人工协助的命令参数。 */
export type BlockCommand = {
  /** 人类可读的完整求助说明。 */
  readonly needHelp: string;
  /** 可选的人类答案 JSON Schema。 */
  readonly answerSchema?: JsonObject;
};

/** 解析 `wave-flow block --need-help <text> [--answer-schema <json>]`。 */
export function parseBlockCommand(argv: readonly string[]): BlockCommand {
  let needHelp: string | null = null;
  let answerSchema: JsonObject | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; const value = argv[++index];
    if (!value) throw new Error(`${flag} 需要值。`);
    if (flag === "--need-help") { if (needHelp !== null) throw new Error("--need-help 只能提供一次。"); needHelp = value; continue; }
    if (flag === "--answer-schema") {
      if (answerSchema !== undefined) throw new Error("--answer-schema 只能提供一次。");
      try { const parsed = JSON.parse(value) as unknown; if (!isJsonObject(parsed)) throw new Error(); answerSchema = parsed; } catch { throw new Error("--answer-schema 必须是 JSON-safe 对象。"); }
      continue;
    }
    throw new Error(`block 不支持选项：${flag}`);
  }
  if (!needHelp?.trim()) throw new Error("block 需要非空 --need-help。");
  return { needHelp, ...(answerSchema ? { answerSchema } : {}) };
}

/** Agent 通过受管环境请求帮助，并在收到耐久答案后返回 JSON 对象。 */
export async function executeBlock(command: BlockCommand, environment: Record<string, string | undefined> = process.env): Promise<BlockResolution> {
  const endpoint = requireLoopbackControlUrl(environment.WF_CONTROL_URL);
  const runId = required(environment, "WF_RUN_ID");
  const response = await fetch(`${endpoint}/runs/${encodeURIComponent(runId)}/control/block`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ blockRequestId: crypto.randomUUID(), runId, nodeId: required(environment, "WF_NODE_ID"), agentSessionId: required(environment, "WF_AGENT_SESSION_ID"), capability: required(environment, "WF_CONTROL_CAPABILITY"), needHelp: command.needHelp, ...(command.answerSchema ? { answerSchema: command.answerSchema } : {}) }),
  });
  const value = await response.json() as BlockResolution | { error?: string };
  if (!response.ok || !("answer" in value) || !("blockRequestId" in value)) throw new Error("error" in value ? value.error ?? `Control block 请求失败：${response.status}` : `Control block 请求失败：${response.status}`);
  return value;
}

function required(environment: Record<string, string | undefined>, name: string): string { const value = environment[name]?.trim(); if (!value) throw new Error(`block 缺少受管会话环境变量：${name}。`); return value; }
function requireLoopbackControlUrl(value: string | undefined): string {
  let url: URL; try { url = new URL(value ?? ""); } catch { throw new Error("block Control URL 无效。"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("block Control URL 必须是无凭据的 http://127.0.0.1:<port>。");
  return url.toString().replace(/\/$/, "");
}
