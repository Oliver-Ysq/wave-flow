import { isJsonObject, type JsonObject } from "../shared/json";
import type { BlockResolution } from "../control/control-server";
import { discoverDaemon } from "../daemon/daemon-lifecycle";
import { parseAgentIdentity, type AgentIdentity } from "./agent-identity";

/** Agent 发起业务型人工协助的命令参数。 */
export type BlockCommand = {
  /** 人类可读的完整求助说明。 */
  readonly needHelp: string;
  /** 可选的人类答案 JSON Schema。 */
  readonly answerSchema?: JsonObject;
  /** Agent 显式携带的稳定会话身份。 */
  readonly identity: AgentIdentity;
};

/** 解析 `wave-flow block --need-help <text> [--answer-schema <json>]`。 */
export function parseBlockCommand(argv: readonly string[]): BlockCommand {
  const parsed = parseAgentIdentity(argv);
  argv = parsed.rest;
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
  return { needHelp, identity: parsed.identity, ...(answerSchema ? { answerSchema } : {}) };
}

/** Agent 通过受管环境请求帮助，并在收到耐久答案后返回 JSON 对象。 */
export async function executeBlock(
  command: BlockCommand,
  discover: () => Promise<{ readonly baseUrl: string } | null> = discoverDaemon,
): Promise<BlockResolution> {
  const body = { blockRequestId: crypto.randomUUID(), ...command.identity, needHelp: command.needHelp, ...(command.answerSchema ? { answerSchema: command.answerSchema } : {}) };
  // daemon 崩溃会中断旧 HTTP 等待；保留同一 request id 重连，绝不另建 block。
  while (true) {
    const daemon = await discover();
    if (!daemon) { await Bun.sleep(500); continue; }
    try {
      const response = await fetch(`${daemon.baseUrl}/runs/${encodeURIComponent(command.identity.runId)}/control/block`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as BlockResolution | { error?: string };
      if (response.ok && "answer" in value && "blockRequestId" in value) return value;
      // 明确的业务/身份拒绝不可靠重试掩盖；仅连接中断才重连。
      throw new Error("error" in value ? value.error ?? `Control block 请求失败：${response.status}` : `Control block 请求失败：${response.status}`);
    } catch (error) {
      if (error instanceof TypeError) { await Bun.sleep(500); continue; }
      throw error;
    }
  }
}
