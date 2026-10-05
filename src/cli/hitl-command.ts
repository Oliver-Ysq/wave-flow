import { isJsonObject, type JsonObject } from "../shared/json";

/** 用户提交答案的命令参数。 */
export type AnswerCommand = { readonly blockRequestId: string; readonly answer: JsonObject };
/** 原 Agent 确认恢复的命令参数。 */
export type ContinueCommand = { readonly blockRequestId: string };

export function parseAnswerCommand(argv: readonly string[]): AnswerCommand {
  const [blockRequestId, flag, value, ...extra] = argv;
  if (!isUuid(blockRequestId) || flag !== "--value" || !value || extra.length > 0) throw new Error("answer 用法：wave-flow answer <block-request-id> --value <json>。");
  try { const answer = JSON.parse(value) as unknown; if (!isJsonObject(answer)) throw new Error(); return { blockRequestId, answer }; } catch { throw new Error("answer --value 必须是 JSON-safe 对象。"); }
}

export function parseContinueCommand(argv: readonly string[]): ContinueCommand {
  if (argv.length !== 2 || argv[0] !== "--block-request-id" || !isUuid(argv[1])) throw new Error("continue 用法：wave-flow continue --block-request-id <id>。");
  return { blockRequestId: argv[1]! };
}

/** 用户侧 answer 只交付答案，不改变 blocked 状态。 */
export async function executeAnswer(command: AnswerCommand, baseUrl: string): Promise<void> {
  await post(`${baseUrl}/blocks/${encodeURIComponent(command.blockRequestId)}/answer`, { answer: command.answer });
}

/** 原受管 Agent 调用 continue，唯一合法的 blocked → running 路径。 */
export async function executeContinue(command: ContinueCommand, environment: Record<string, string | undefined> = process.env): Promise<void> {
  const endpoint = requiredLoopback(environment.WF_CONTROL_URL);
  const runId = required(environment, "WF_RUN_ID");
  await post(`${endpoint}/runs/${encodeURIComponent(runId)}/control/continue`, { runId, nodeId: required(environment, "WF_NODE_ID"), agentSessionId: required(environment, "WF_AGENT_SESSION_ID"), capability: required(environment, "WF_CONTROL_CAPABILITY"), blockRequestId: command.blockRequestId });
}

async function post(url: string, body: JsonObject): Promise<void> { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const value = await response.json() as { error?: string }; if (!response.ok) throw new Error(value.error ?? `Control 请求失败：${response.status}`); }
function required(env: Record<string, string | undefined>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`continue 缺少受管会话环境变量：${name}。`); return value; }
function requiredLoopback(value: string | undefined): string { let url: URL; try { url = new URL(value ?? ""); } catch { throw new Error("continue Control URL 无效。"); } if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("continue Control URL 必须是无凭据的 http://127.0.0.1:<port>。"); return url.toString().replace(/\/$/, ""); }
function isUuid(value: string | undefined): value is string { return !!value && /^[0-9a-f-]{36}$/i.test(value); }
