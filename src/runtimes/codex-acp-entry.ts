/**
 * 固定的 ACP adapter 启动入口。编译后的 Engine 已把 `__codex-acp` 作为 Bun 内置
 * adapter 子命令；开发态才从锁定 node_modules 解析 JS 入口。它不是 Codex CLI，
 * 真正执行 CLI 永远由 CODEX_PATH 指向用户确认的 realpath。
 */
export function codexAcpAdapterEntry(): { readonly command: string; readonly args: readonly string[] } {
  const compiled = process.env.WF_DESKTOP_ENGINE === "1" || import.meta.dir.startsWith("/$bunfs/");
  return compiled ? { command: process.execPath, args: ["__codex-acp"] } : { command: process.execPath, args: [Bun.resolveSync("@agentclientprotocol/codex-acp", import.meta.dir)] };
}
