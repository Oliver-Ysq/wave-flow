import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock, DAEMON_PROTOCOL_VERSION, daemonUserIdentity, descriptorPath, lockPath, publishDescriptor, readFreshDescriptor, removeDeadDaemonArtifacts, removeOwnDescriptor } from "../../src/daemon/daemon-descriptor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wave-flow-daemon-descriptor-")); directories.push(path); return path; }
function descriptor(bootInstanceId = "boot"): Parameters<typeof publishDescriptor>[0] { return { protocolVersion: DAEMON_PROTOCOL_VERSION, userIdentity: daemonUserIdentity(), bootInstanceId, port: 43123, pid: process.pid, processStartIdentity: "test-process", heartbeatAt: new Date().toISOString() }; }

describe("全局 daemon descriptor", () => {
  test("当前协议 daemon 启动身份不可读取时保持 descriptor 与 lock", async () => {
    const directory = await root(); await (await import("node:fs/promises")).mkdir(directory, { recursive: true, mode: 0o700 });
    await publishDescriptor(descriptor("unknown"), directory);
    await writeFile(lockPath(directory), JSON.stringify({ pid: process.pid, processStartIdentity: "old", bootInstanceId: "unknown" }), { mode: 0o600 });
    await expect(removeDeadDaemonArtifacts(directory, async () => { throw new Error("ps temporarily unavailable"); })).resolves.toBe(false);
    await expect((await import("node:fs/promises")).access(descriptorPath(directory))).resolves.toBeNull();
    await expect((await import("node:fs/promises")).access(lockPath(directory))).resolves.toBeNull();
  });
  test("原子发布后仅在身份、版本和 heartbeat 均有效时可发现", async () => {
    const directory = await root();
    await publishDescriptor(descriptor(), directory);
    await expect(readFreshDescriptor(directory)).resolves.toMatchObject({ bootInstanceId: "boot", userIdentity: daemonUserIdentity() });
  });

  test("拒绝宽权限、过期 heartbeat 和损坏 descriptor", async () => {
    const directory = await root();
    await publishDescriptor(descriptor(), directory);
    await chmod(descriptorPath(directory), 0o644);
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
    await writeFile(descriptorPath(directory), JSON.stringify({ ...descriptor(), heartbeatAt: "2020-01-01T00:00:00.000Z" }), { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
    await writeFile(descriptorPath(directory), "not-json", { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
  });

  test("拒绝不属于当前用户的 descriptor 目录或文件", async () => {
    const directory = await root();
    await publishDescriptor(descriptor(), directory);
    await chmod(directory, 0o755);
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
  });

  test("已有私有运行目录只校验，不依赖重复 chmod", async () => {
    const directory = await root();
    await chmod(directory, 0o700);
    await expect(publishDescriptor(descriptor(), directory)).resolves.toBeUndefined();
  });

  test("旧 daemon 不能删除新 boot 的 descriptor", async () => {
    const directory = await root();
    await publishDescriptor(descriptor("new-boot"), directory);
    await removeOwnDescriptor("old-boot", directory);
    await expect(readFreshDescriptor(directory)).resolves.toMatchObject({ bootInstanceId: "new-boot" });
  });

  test("损坏的启动锁必须拒绝接管，而不是删除后重试", async () => {
    const directory = await root();
    await writeFile(lockPath(directory), "broken", { mode: 0o600 });
    await expect(acquireDaemonLock("new-boot", directory)).rejects.toThrow("锁损坏");
  });

  test("拒绝旧协议或缺字段 descriptor", async () => {
    const directory = await root();
    await writeFile(descriptorPath(directory), JSON.stringify({ ...descriptor(), protocolVersion: 1 }), { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
    const { processStartIdentity: _omitted, ...incomplete } = descriptor();
    await writeFile(descriptorPath(directory), JSON.stringify(incomplete), { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
  });

  test("无法验证旧 lock 进程时必须拒绝接管", async () => {
    const directory = await root();
    await writeFile(lockPath(directory), JSON.stringify({ pid: 999_999_999, processStartIdentity: "old", bootInstanceId: "dead-boot" }), { mode: 0o600 });
    await expect(acquireDaemonLock("new-boot", directory, async () => "unknown")).rejects.toThrow("无法验证");
  });
});
