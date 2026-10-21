import { isAbsolute } from "node:path";

/**
 * ACP stdio MCP server 的 command 必须是绝对路径。
 *
 * 依据：DeepSeek Harness 对 `session/new` 的 `mcpServers[].command` 显式校验绝对路径，
 * 相对命令会以 `Invalid params` 拒绝整个会话；其他 CLI 虽更宽松，但相对命令的解析
 * 结果依赖子进程 cwd/PATH，无法作为可复核的启动契约。Engine 侧统一使用
 * `process.execPath`，此断言防止未来改动把这条兼容性前提弄丢。
 */
export function assertAbsoluteMcpCommand(server: { readonly name: string; readonly command: string }): void {
  if (!isAbsolute(server.command)) throw new Error(`MCP server ${server.name} 的 command 必须是绝对路径（当前为 ${server.command}）。 `);
}
