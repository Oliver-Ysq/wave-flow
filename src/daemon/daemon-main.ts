#!/usr/bin/env bun
import { LocalDaemon } from "./local-daemon";
import { acquireDaemonLock, DAEMON_PROTOCOL_VERSION, daemonUserIdentity, processStartIdentity, publishDescriptor, removeOwnDescriptor, removeOwnLock } from "./daemon-descriptor";

const bootInstanceId = crypto.randomUUID();
if (!(await acquireDaemonLock(bootInstanceId))) process.exit(0);
let closeDaemon: (() => void) | null = null;
const daemon = new LocalDaemon({ scheduleClose: () => closeDaemon?.() });
try {
  daemon.setBootInstanceId(bootInstanceId);
  await daemon.reconcileRunControl();
  const server = daemon.start();
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
