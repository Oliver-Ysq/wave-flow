import { isJsonObject, type JsonObject } from "../shared/json";
import { discoverDaemon } from "../daemon/daemon-lifecycle";
import { parseAgentIdentity, type AgentIdentity } from "./agent-identity";

/** 用户提交答案的命令参数。 */
export type AnswerCommand = { readonly blockRequestId: string; readonly answer: JsonObject };
/** 原 Agent 确认恢复的命令参数。 */
export type ContinueCommand = { readonly blockRequestId: string; readonly identity: AgentIdentity };

export function parseAnswerCommand(argv: readonly string[]): AnswerCommand {
  const [blockRequestId, flag, value, ...extra] = argv;
  if (!isUuid(blockRequestId) || flag !== "--value" || !value || extra.length > 0) throw new Error("answer 用法：wave-flow answer <block-request-id> --value <json>。");
  try { const answer = JSON.parse(value) as unknown; if (!isJsonObject(answer)) throw new Error(); return { blockRequestId, answer }; } catch { throw new Error("answer --value 必须是 JSON-safe 对象。"); }
}

export function parseContinueCommand(argv: readonly string[]): ContinueCommand {
  const parsed = parseAgentIdentity(argv);
  if (parsed.rest.length !== 2 || parsed.rest[0] !== "--block-request-id" || !isUuid(parsed.rest[1])) throw new Error("continue 用法：wave-flow continue --block-request-id <id> --run-id <id> --node-id <id> --agent-session-id <id>。");
  return { blockRequestId: parsed.rest[1]!, identity: parsed.identity };
}

/** 用户侧 answer 只交付答案，不改变 blocked 状态。 */
export async function executeAnswer(command: AnswerCommand, baseUrl: string): Promise<void> {
  await post(`${baseUrl}/blocks/${encodeURIComponent(command.blockRequestId)}/answer`, { answer: command.answer });
}

/** 原受管 Agent 调用 continue，唯一合法的 blocked → running 路径。 */
export async function executeContinue(
  command: ContinueCommand,
  discover: () => Promise<{ readonly baseUrl: string } | null> = discoverDaemon,
): Promise<void> {
  const daemon = await discover();
  if (!daemon) throw new Error("没有可验证的 Wave Flow daemon，无法认领并继续旧 Agent 会话。");
  await post(`${daemon.baseUrl}/runs/${encodeURIComponent(command.identity.runId)}/control/continue`, { ...command.identity, blockRequestId: command.blockRequestId });
}

async function post(url: string, body: JsonObject): Promise<void> { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const value = await response.json() as { error?: string }; if (!response.ok) throw new Error(value.error ?? `Control 请求失败：${response.status}`); }
function isUuid(value: string | undefined): value is string { return !!value && /^[0-9a-f-]{36}$/i.test(value); }
