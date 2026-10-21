/**
 * 固定的 Claude Code ACP adapter 启动入口。编译后的 Engine 已把 `__claude-acp` 作为
 * Bun 内置 adapter 子命令；开发态才从锁定 node_modules 解析 JS 入口。它不是 Claude CLI，
 * 真正执行 CLI 永远由 CLAUDE_CODE_EXECUTABLE 指向用户确认的 realpath。
 */
export function claudeAcpAdapterEntry(): { readonly command: string; readonly args: readonly string[] } {
  const compiled = process.env.WF_DESKTOP_ENGINE === "1" || import.meta.dir.startsWith("/$bunfs/");
  // 该包 main 指向 lib.js（库入口，会静默退出），ACP server 是 bin 入口 dist/index.js，必须显式解析。
  return compiled ? { command: process.execPath, args: ["__claude-acp"] } : { command: process.execPath, args: [Bun.resolveSync("@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.dir)] };
}
