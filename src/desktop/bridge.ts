#!/usr/bin/env bun
import { basename, dirname, join } from "node:path";
import { ensureGlobalDaemon } from "../daemon/daemon-lifecycle";

/**
 * Tauri 的唯一 Bun sidecar bridge：复用 daemon 的安全发现/启动协议，向桌面壳返回
 * 已经完成 descriptor、PID 与 health 校验的 loopback 地址。
 */
async function main(): Promise<void> {
  const bridgeName = basename(process.execPath);
  const daemonName = bridgeName.replace("wave-flow-desktop-bridge", "wave-flow-daemon");
  if (daemonName === bridgeName) throw new Error("桌面 bridge 文件名无法推导 daemon sidecar。 ");
  const executable = join(dirname(process.execPath), daemonName);
  const webDist = process.env.WF_WEB_DIST;
  if (!webDist) throw new Error("桌面 bridge 缺少受控 Web 资源目录。");
  const daemon = await ensureGlobalDaemon(10_000, undefined, executable, { WF_WEB_DIST: webDist });
  process.stdout.write(`${JSON.stringify({ baseUrl: daemon.baseUrl })}\n`);
}

main().catch((error) => {
  process.stderr.write(`wave-flow desktop bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
