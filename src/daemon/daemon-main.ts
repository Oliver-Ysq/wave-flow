#!/usr/bin/env bun
import { LocalDaemon } from "./local-daemon";
import { acquireDaemonLock, DAEMON_PROTOCOL_VERSION, daemonUserIdentity, processStartIdentity, publishDescriptor, removeOwnDescriptor, removeOwnLock } from "./daemon-descriptor";

const daemon = new LocalDaemon();
const bootInstanceId = crypto.randomUUID();
if (!(await acquireDaemonLock(bootInstanceId))) process.exit(0);
try {
  daemon.setBootInstanceId(bootInstanceId);
  const server = daemon.start();
  const startedAt = await processStartIdentity(process.pid);
  const descriptor = () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, userIdentity: daemonUserIdentity(), bootInstanceId, port: Number(new URL(server.baseUrl).port), pid: process.pid, processStartIdentity: startedAt, heartbeatAt: new Date().toISOString() } as const);
  await publishDescriptor(descriptor());
  const heartbeat = setInterval(() => { void publishDescriptor(descriptor()).catch(() => {}); }, 5_000);
  const stop = async () => { clearInterval(heartbeat); await removeOwnDescriptor(bootInstanceId).catch(() => {}); await removeOwnLock(bootInstanceId).catch(() => {}); server.stop(); };
  process.on("SIGINT", () => { void stop().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
  await new Promise<void>(() => {});
} catch (error) {
  await removeOwnLock(bootInstanceId).catch(() => {});
  throw error;
}
