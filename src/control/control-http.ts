import type { JsonObject } from "../shared/json";
import type { CompleteRequest, ControlServer } from "./control-server";

/** Control complete 的 loopback JSON 请求体；CLI 必须上传已读取的结果对象，而非文件路径。 */
export type CompleteHttpRequest = CompleteRequest;

/** 将一个已绑定节点的 ControlServer 挂载为单一路由；调用方负责 daemon 的 Run 路由与生命周期。 */
export async function handleCompleteHttp(control: ControlServer, request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") return Response.json({ error: "Control complete 只接受 POST。" }, { status: 405 });
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "Control complete 请求必须使用 application/json。" }, { status: 415 });
    const value = await request.json() as unknown;
    if (!isCompleteHttpRequest(value)) return Response.json({ error: "Control complete 请求无效。" }, { status: 400 });
    await control.complete(value);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function isCompleteHttpRequest(value: unknown): value is CompleteHttpRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.runId === "string" && typeof request.nodeId === "string" && typeof request.agentSessionId === "string" && typeof request.capability === "string" && typeof request.summary === "string" && isJsonObject(request.result);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
