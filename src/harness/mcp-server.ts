import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** 由 daemon 以每个 Harness session 私有 token 启动的 MCP sidecar。 */
export async function runHarnessMcpServer(): Promise<void> {
  const baseUrl = process.env.WF_HARNESS_MCP_BASE_URL;
  const token = process.env.WF_HARNESS_MCP_TOKEN;
  if (!baseUrl || !token) throw new Error("Harness MCP sidecar 缺少受控身份。 ");
  const server = new Server({ name: "wave-flow-harness", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => await request(baseUrl, token, "list", {}));
  server.setRequestHandler(CallToolRequestSchema, async requestValue => {
    const result = await request(baseUrl, token, "call", { name: requestValue.params.name, arguments: requestValue.params.arguments ?? {} });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  await server.connect(new StdioServerTransport());
}

async function request(baseUrl: string, token: string, operation: string, value: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}/harness-mcp/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, value }) });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Harness MCP 请求失败。 ");
  return body;
}
