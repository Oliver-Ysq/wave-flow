/**
 * 真机取证用的 MCP sidecar 启动包装器。
 *
 * 宿主只能通过 ACP 的 MCP 配置（command/args/env）交付 sidecar，真实 CLI 由适配器拉起它。
 * 这个包装器做两件事，都只观察、不改写：
 * 1. 把自己收到的 WF_ 前缀环境变量落盘，证明宿主下发的配置真的穿过了真实适配器的进程边界；
 * 2. 把 sidecar 的 stdio 响应帧复制一份落盘，证明工具声明真的以什么形状出现在线上。
 *
 * 它不解析业务语义，只按 NDJSON 逐行留存原始帧。
 */
export {};

const [, , target, envLogPath, framesLogPath] = process.argv;
if (!target || !envLogPath || !framesLogPath) throw new Error("mcp-env-tap 需要 sidecar 入口、环境日志路径与帧日志路径。");
await Bun.write(envLogPath, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("WF_"))), null, 1));
const child = Bun.spawn([process.execPath, target, "__worker-mcp"], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env: process.env });
const frameLog = Bun.file(framesLogPath).writer();
for await (const chunk of child.stdout) {
  await frameLog.write(chunk);
  process.stdout.write(chunk);
}
await frameLog.end();
process.exit(await child.exited);
