import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectControlSocket } from "../runtime/control-socket";

/** 由 Engine 以每个 Harness session 私有 token 启动的 MCP sidecar。 */
export async function runHarnessMcpServer(): Promise<void> {
  const control = await connectControlSocket({ socketPath: required("WF_HARNESS_CONTROL_SOCKET"), idPrefix: "harness" });
  const server = new Server({ name: "wave-flow-harness", version: "1" }, { capabilities: { tools: {} } });
  let closing = false;
  let inFlight = 0;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    control.close();
    await server.close();
    // Engine 关闭通道或 stdio 结束时自行退出，避免成为孤儿进程；先 flush 再退出。
    process.stdout.write("", () => process.exit(0));
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => await control.request({ operation: "list", value: {} }) as { tools: unknown[] });
  server.setRequestHandler(CallToolRequestSchema, async requestValue => {
    inFlight += 1;
    try {
      const result = await control.request({ operation: "call", value: { name: requestValue.params.name, arguments: requestValue.params.arguments ?? {} } });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } finally { inFlight -= 1; }
  });
  await server.connect(new StdioServerTransport());
  // 连接建立后再挂退出钩子：通道被 Engine 关闭或 stdio 结束时自行退出，
  // socket 关闭事件可靠，不轮询端点文件。
  // 在途 tools/call 必须先把"通道已关闭"的错误写回 stdio 再退出，否则调用方只能等到超时。
  void control.closed.then(async () => {
    for (let index = 0; index < 40 && inFlight > 0; index += 1) await Bun.sleep(50);
    await close();
  });
  process.stdin.once("end", () => { void close(); });
}

function required(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`Harness MCP 服务缺少 ${key}。`); return value; }
