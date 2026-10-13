import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock, DAEMON_PROTOCOL_VERSION, daemonUserIdentity, descriptorPath, lockPath, publishDescriptor, readFreshDaemonCandidate, readFreshDescriptor, readFreshDescriptorProtocol, readIncompatibleFreshDescriptor, removeDeadDaemonArtifacts, removeOwnDescriptor } from "../../src/daemon/daemon-descriptor";
import { discoverDaemon } from "../../src/daemon/daemon-lifecycle";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "wave-flow-daemon-descriptor-")); directories.push(path); return path; }
function descriptor(bootInstanceId = "boot"): Parameters<typeof publishDescriptor>[0] { return { protocolVersion: DAEMON_PROTOCOL_VERSION, webBuildId: "a".repeat(64), userIdentity: daemonUserIdentity(), bootInstanceId, port: 43123, pid: process.pid, processStartIdentity: "test-process", heartbeatAt: new Date().toISOString() }; }

describe("全局 daemon descriptor", () => {
  test("旧协议 daemon 仍可仅删除自己的 descriptor，供受控升级释放运行目录", async () => {
    const directory = await root(); const boot = "old-daemon";
    await (await import("node:fs/promises")).mkdir(directory, { recursive: true, mode: 0o700 });
    await (await import("node:fs/promises")).writeFile(descriptorPath(directory), `${JSON.stringify({ protocolVersion: 2, userIdentity: daemonUserIdentity(), bootInstanceId: boot, port: 43123, pid: process.pid, processStartIdentity: "old", heartbeatAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await removeOwnDescriptor(boot, directory);
    await expect((await import("node:fs/promises")).access(descriptorPath(directory))).rejects.toThrow();
  });

  test("旧协议 descriptor 的 PID 已死亡时才清理其遗留记录", async () => {
    const directory = await root(); await (await import("node:fs/promises")).mkdir(directory, { recursive: true, mode: 0o700 });
    await (await import("node:fs/promises")).writeFile(descriptorPath(directory), `${JSON.stringify({ protocolVersion: 2, userIdentity: daemonUserIdentity(), bootInstanceId: "dead", port: 43123, pid: 999999, processStartIdentity: "dead", heartbeatAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await expect(removeDeadDaemonArtifacts(directory, async () => "replacement-process-start")).resolves.toBe(true);
    await expect((await import("node:fs/promises")).access(descriptorPath(directory))).rejects.toThrow();
  });

  test("旧协议 daemon 启动身份不可读取时保持 descriptor 与 lock，拒绝猜测其已死亡", async () => {
    const directory = await root();
    await (await import("node:fs/promises")).mkdir(directory, { recursive: true, mode: 0o700 });
    const value = { protocolVersion: 2, userIdentity: daemonUserIdentity(), bootInstanceId: "unknown", port: 43123, pid: process.pid, processStartIdentity: "old", heartbeatAt: new Date().toISOString() };
    await (await import("node:fs/promises")).writeFile(descriptorPath(directory), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await writeFile(lockPath(directory), JSON.stringify({ pid: process.pid, processStartIdentity: "old", bootInstanceId: "unknown" }), { mode: 0o600 });
    await expect(removeDeadDaemonArtifacts(directory, async () => { throw new Error("ps temporarily unavailable"); })).resolves.toBe(false);
    await expect((await import("node:fs/promises")).access(descriptorPath(directory))).resolves.toBeNull();
    await expect((await import("node:fs/promises")).access(lockPath(directory))).resolves.toBeNull();
  });

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

  test("同协议但缺少 Web 构建指纹的旧 daemon 不可复用", async () => {
    const directory = await root();
    const { webBuildId: _removed, ...legacyWithoutBuild } = descriptor();
    await writeFile(descriptorPath(directory), JSON.stringify(legacyWithoutBuild), { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
    const candidate = await readFreshDaemonCandidate(directory);
    expect(candidate).toMatchObject({ protocolVersion: DAEMON_PROTOCOL_VERSION });
    expect(candidate?.webBuildId).toBeUndefined();
  });

  test("同协议但 Web 构建不同的 daemon 不得被 desktop bridge 复用", async () => {
    const directory = await root();
    const buildId = "a".repeat(64);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ protocolVersion: DAEMON_PROTOCOL_VERSION, webBuildId: buildId, userIdentity: daemonUserIdentity(), bootInstanceId: "web-build" }) });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("测试 daemon 未分配端口。 ");
      await publishDescriptor({ ...descriptor("web-build"), webBuildId: buildId, port }, directory);
      await expect(discoverDaemon(directory, async () => "test-process", buildId)).resolves.toMatchObject({ baseUrl: `http://127.0.0.1:${port}` });
      await expect(discoverDaemon(directory, async () => "test-process", "b".repeat(64))).resolves.toBeNull();
    } finally { server.stop(true); }
  });

  test("可读取新鲜旧协议版本以给出升级诊断，但不会把它当可复用 daemon", async () => {
    const directory = await root();
    await writeFile(descriptorPath(directory), JSON.stringify({ ...descriptor(), protocolVersion: 1 }), { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
    await expect(readFreshDescriptorProtocol(directory)).resolves.toBe(1);
  });

  test("可识别协议相同但缺少当前字段的旧 descriptor，供升级诊断使用", async () => {
    const directory = await root();
    const { processStartIdentity: _omitted, ...oldFormat } = descriptor();
    await writeFile(descriptorPath(directory), JSON.stringify(oldFormat), { mode: 0o600 });
    await expect(readFreshDescriptor(directory)).resolves.toBeNull();
    await expect(readIncompatibleFreshDescriptor(directory)).resolves.toBe(DAEMON_PROTOCOL_VERSION);
  });

  test("无法验证旧 lock 进程时必须拒绝接管", async () => {
    const directory = await root();
    await writeFile(lockPath(directory), JSON.stringify({ pid: 999_999_999, processStartIdentity: "old", bootInstanceId: "dead-boot" }), { mode: 0o600 });
    await expect(acquireDaemonLock("new-boot", directory, async () => "unknown")).rejects.toThrow("无法验证");
  });
});
