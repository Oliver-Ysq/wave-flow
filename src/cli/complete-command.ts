import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { JsonObject } from "../shared/json";

/** 解析后的受管 complete 命令；仅能从受管会话环境构造身份和 loopback 地址。 */
export type CompleteCommand = {
  /** 面向 Run 诊断的非空摘要。 */
  readonly summary: string;
  /** 由 Agent 指定、仅在 Agent 本地读取的绝对 JSON 文件路径。 */
  readonly resultFile: string;
};

/** 解析 `wave-flow complete --summary ... --result-file ...`。 */
export function parseCompleteCommand(argv: readonly string[]): CompleteCommand {
  let summary: string | null = null;
  let resultFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`${flag} 需要值。`);
    if (flag === "--summary") { if (summary !== null) throw new Error("--summary 只能提供一次。"); summary = value; continue; }
    if (flag === "--result-file") { if (resultFile !== null) throw new Error("--result-file 只能提供一次。"); resultFile = value; continue; }
    throw new Error(`complete 不支持选项：${flag}`);
  }
  if (!summary?.trim() || !resultFile) throw new Error("complete 需要 --summary 与 --result-file。");
  if (!isAbsolute(resultFile)) throw new Error("complete 的 --result-file 必须是绝对路径。");
  return { summary, resultFile };
}

/** 读取本地 JSON 对象并上传给 Control；daemon 永远不会读取 Agent 指定的路径。 */
export async function executeComplete(command: CompleteCommand, environment: Record<string, string | undefined> = process.env): Promise<void> {
  const result = await readResult(command.resultFile);
  const endpoint = requireLoopbackControlUrl(environment.WF_CONTROL_URL);
  const runId = requiredEnvironment(environment, "WF_RUN_ID");
  const response = await fetch(`${endpoint}/runs/${encodeURIComponent(runId)}/control/complete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, nodeId: requiredEnvironment(environment, "WF_NODE_ID"), agentSessionId: requiredEnvironment(environment, "WF_AGENT_SESSION_ID"), capability: requiredEnvironment(environment, "WF_CONTROL_CAPABILITY"), summary: command.summary, result }),
  });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Control complete 请求失败：${response.status}`);
}

async function readResult(path: string): Promise<JsonObject> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")) as unknown; } catch (error) { throw new Error(`complete 结果文件不可读取：${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("complete 结果必须是 JSON 对象。");
  return value as JsonObject;
}

function requiredEnvironment(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`complete 缺少受管会话环境变量：${name}。`);
  return value;
}

function requireLoopbackControlUrl(value: string | undefined): string {
  if (!value) throw new Error("complete 缺少受管 Control URL。");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("complete Control URL 无效。"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("complete Control URL 必须是无凭据的 http://127.0.0.1:<port>。");
  return url.toString().replace(/\/$/, "");
}
