import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * CLI 验证用的最小 MCP 探针 sidecar。
 *
 * 验证候选 CLI 的 ACP `session/new` 是否真实 spawn 并完成客户端注入的 stdio MCP
 * 握手；它不暴露任何工具、不读写业务状态，进程随验证结束被回收。
 */
export async function runMcpProbeServer(): Promise<void> {
  const server = new Server({ name: "wave-flow-mcp-probe", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await server.connect(new StdioServerTransport());
}
