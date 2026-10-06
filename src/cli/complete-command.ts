import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { JsonObject } from "../shared/json";
import { discoverDaemon } from "../daemon/daemon-lifecycle";
import { parseAgentIdentity, type AgentIdentity } from "./agent-identity";

/** 解析后的受管 complete 命令；仅能从受管会话环境构造身份和 loopback 地址。 */
export type CompleteCommand = {
  /** 面向 Run 诊断的非空摘要。 */
  readonly summary: string;
  /** 由 Agent 指定、仅在 Agent 本地读取的绝对 JSON 文件路径。 */
  readonly resultFile: string;
  /** 由受管 Agent 在 Prompt 中取得并显式传入的稳定身份。 */
  readonly identity: AgentIdentity;
};

/** 解析 `wave-flow complete --summary ... --result-file ...`。 */
export function parseCompleteCommand(argv: readonly string[]): CompleteCommand {
  const parsed = parseAgentIdentity(argv);
  argv = parsed.rest;
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
  return { summary, resultFile, identity: parsed.identity };
}

/**
 * 读取本地 JSON 对象并经当前 daemon 的 reclaim 路由完成。
 * Agent 不保存某一代 daemon URL 或 capability；每次 complete 都重新发现 daemon。
 */
export async function executeComplete(
  command: CompleteCommand,
  discover: () => Promise<{ readonly baseUrl: string } | null> = discoverDaemon,
): Promise<void> {
  const result = await readResult(command.resultFile);
  const daemon = await discover();
  if (!daemon) throw new Error("没有可验证的 Wave Flow daemon，无法认领并完成旧 Agent 会话。");
  const response = await fetch(`${daemon.baseUrl}/runs/${encodeURIComponent(command.identity.runId)}/control/reclaim-complete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...command.identity, summary: command.summary, result }),
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
