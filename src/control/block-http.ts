import type { JsonObject } from "../shared/json";
import type { BlockAnswerSubmission, BlockSubmission, ContinueSubmission, ControlServer } from "./control-server";

/** 将受管 Agent 的 block 请求挂载为 loopback HTTP 路由。 */
export async function handleBlockHttp(control: ControlServer, request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return Response.json({ error: "Control block 只接受 POST。" }, { status: 405 });
    const value = await readJson(request);
    if (!isBlockSubmission(value)) return Response.json({ error: "Control block 请求无效。" }, { status: 400 });
    const resolution = await control.block(value);
    return Response.json(resolution);
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}

/** 人类答案路由；答案只唤醒原 block 命令，不改变节点状态。 */
export async function handleAnswerHttp(control: ControlServer, blockRequestId: string, request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return Response.json({ error: "Control answer 只接受 POST。" }, { status: 405 });
    const value = await readJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonObject((value as Record<string, unknown>).answer)) return Response.json({ error: "Control answer 请求无效。" }, { status: 400 });
    const submission: BlockAnswerSubmission = { blockRequestId, answer: (value as { answer: JsonObject }).answer };
    await control.answer(submission);
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}

/** 原 Agent 的 continue 路由；只有它可使 blocked 变回 running。 */
export async function handleContinueHttp(control: ControlServer, request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return Response.json({ error: "Control continue 只接受 POST。" }, { status: 405 });
    const value = await readJson(request);
    if (!isContinueSubmission(value)) return Response.json({ error: "Control continue 请求无效。" }, { status: 400 });
    await control.continue(value);
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("Control 请求必须使用 application/json。");
  try { return await request.json(); } catch { throw new Error("Control 请求 JSON 无效。"); }
}

function isBlockSubmission(value: unknown): value is BlockSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.blockRequestId === "string" && typeof item.runId === "string" && typeof item.nodeId === "string" && typeof item.agentSessionId === "string" && typeof item.capability === "string" && typeof item.needHelp === "string" && (item.answerSchema === undefined || isJsonObject(item.answerSchema));
}

function isContinueSubmission(value: unknown): value is ContinueSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.blockRequestId === "string" && typeof item.runId === "string" && typeof item.nodeId === "string" && typeof item.agentSessionId === "string" && typeof item.capability === "string";
}

function isJsonObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
