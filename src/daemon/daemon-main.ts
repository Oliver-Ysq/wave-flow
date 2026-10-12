#!/usr/bin/env bun
export {};
import { basename } from "node:path";

// 编译版 daemon 无法从 /$bunfs 向子进程暴露 node_modules 路径。ACP adapter 因此
// 由同一受控二进制以专用子命令启动；普通 daemon 永不 import 该 CLI entry。
if (process.argv[2] === "__codex-acp") {
  await import("@agentclientprotocol/codex-acp");
} else if (process.argv[2] === "__harness-mcp") {
  const { runHarnessMcpServer } = await import("../harness/mcp-server");
  await runHarnessMcpServer();
} else if (process.argv[2] === "__wave-flow-cli" || basename(process.execPath) === "wave-flow") {
  const { main } = await import("../cli/main");
  // Bun compiled executable 的 argv[1] 是 /$bunfs 内部脚本路径，不是用户命令。
  await main(process.argv[2] === "__wave-flow-cli" ? process.argv.slice(3) : process.argv.slice(2));
} else {
  const { LocalDaemon } = await import("./local-daemon");
  const { acquireDaemonLock, DAEMON_PROTOCOL_VERSION, daemonUserIdentity, processStartIdentity, publishDescriptor, removeOwnDescriptor, removeOwnLock } = await import("./daemon-descriptor");
  const bootInstanceId = crypto.randomUUID();
  if (!(await acquireDaemonLock(bootInstanceId))) process.exit(0);
  let closeDaemon: (() => void) | null = null;
  const daemon = new LocalDaemon({ scheduleClose: () => closeDaemon?.() });
  try {
    daemon.setBootInstanceId(bootInstanceId);
    await daemon.reconcileRunControl();
    const server = daemon.start();
    if (process.env.WF_RECONNECT_EXISTING === "1") await daemon.reconnectExistingTerminalSessions();
    const startedAt = await processStartIdentity(process.pid);
    const descriptor = () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, userIdentity: daemonUserIdentity(), bootInstanceId, port: Number(new URL(server.baseUrl).port), pid: process.pid, processStartIdentity: startedAt, heartbeatAt: new Date().toISOString() } as const);
    await publishDescriptor(descriptor());
    const heartbeat = setInterval(() => { void publishDescriptor(descriptor()).catch(() => {}); }, 5_000);
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      await removeOwnDescriptor(bootInstanceId).catch(() => {});
      await removeOwnLock(bootInstanceId).catch(() => {});
      server.stop();
    };
    closeDaemon = () => { void stop().finally(() => process.exit(0)); };
    process.on("SIGINT", () => { void stop().finally(() => process.exit(0)); });
    process.on("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
    await new Promise<void>(() => {});
  } catch (error) {
    await removeOwnLock(bootInstanceId).catch(() => {});
    throw error;
  }
}
