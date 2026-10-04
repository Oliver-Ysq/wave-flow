import { join } from "node:path";
import { TmuxSessionBackend } from "../sessions/backends/tmux-session-backend";
import { privateTmuxSocketPath, TmuxCommandClient } from "../sessions/backends/tmux-command";
import { RealCodexExecutor } from "./real-codex-executor";

/** 为一个前台 daemon 创建唯一私有 tmux socket 上的真实 Codex 执行器。 */
export function createRealCodexExecutor(args: { readonly controlUrl: string; readonly runsRoot: string; readonly daemonInstanceId: string; /** App Server hybrid 投递开关；调用方省略时应使用 true。 */ readonly codexRpcInput: boolean }): RealCodexExecutor {
  const runtimeRoot = join(args.runsRoot, "..", "runtime");
  const socket = privateTmuxSocketPath(runtimeRoot, args.daemonInstanceId);
  return new RealCodexExecutor(new TmuxSessionBackend(new TmuxCommandClient(socket)), args.controlUrl, args.runsRoot, undefined, 1_000, args.codexRpcInput);
}
