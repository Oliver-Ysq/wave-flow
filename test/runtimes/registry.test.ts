import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import { verifyExecutable } from "../../src/runtimes/identity";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function record(root: string, name = "codex"): Promise<CliRuntimeRecord> {
  const executablePath = join(root, name); await writeFile(executablePath, "#!/bin/sh\necho codex\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  return { runtimeId: crypto.randomUUID(), cli: "codex", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "codex-cli 1.0", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
}

async function kimiRecord(root: string, name: string): Promise<CliRuntimeRecord> {
  const executablePath = join(root, name); await writeFile(executablePath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  return { runtimeId: crypto.randomUUID(), cli: "kimi", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "kimi 2.1.1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
}

describe("CliRuntimeRegistry", () => {
  test("仅在明确选择后解析 runtime，并且 Web 列表不泄露文件身份", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-registry-")); roots.push(root); const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await record(root));
    await expect(registry.resolveSelected("codex")).rejects.toThrow("未选择");
    await registry.select(saved.runtimeId);
    await expect(registry.resolveSelected("codex")).resolves.toMatchObject({ runtimeId: saved.runtimeId, executablePath: saved.executablePath });
    const listed = await registry.list(); expect(JSON.stringify(listed)).not.toContain("inode"); expect(listed.selectedByCli.codex).toBe(saved.runtimeId);
  });

  test("可执行文件变化会标记 needs-revalidation 并拒绝启动", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-drift-")); roots.push(root); const registry = new CliRuntimeRegistry(root,async()=>{throw Error("探针失败");}); const saved = await registry.saveVerified(await record(root)); await registry.select(saved.runtimeId);
    await Bun.sleep(5); await writeFile(saved.executablePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(saved.executablePath, 0o700);
    await expect(registry.resolveSelected("codex")).rejects.toThrow("已变化");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
  });

  test("node 依赖变化同样持久化 needs-revalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-node-drift-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root,async()=>{throw Error("探针失败");}); const saved = await registry.saveVerified(await record(root));
    const nodePath = join(root, "node"); await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(nodePath, 0o700);
    const node = await verifyExecutable(nodePath);
    await registry.saveVerified({ ...saved, nodeExecutable: { path: node.executablePath, identity: node.identity } });
    await registry.select(saved.runtimeId);
    await Bun.sleep(5); await writeFile(nodePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(nodePath, 0o700);
    await expect(registry.resolveSelected("codex")).rejects.toThrow("node 依赖已变化");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
  });

  test("旧 Codex runtime 记录在读取时补齐 harnessTools 能力", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-legacy-capability-")); roots.push(root);
    const legacy = await record(root); const { harnessTools: _removed, ...adapter } = legacy.verifiedAdapter;
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: { codex: legacy.runtimeId }, runtimes: [{ ...legacy, verifiedAdapter: adapter }] })}\n`);
    await Bun.file(join(root, "runtimes.json")).write(await Bun.file(join(root, "runtimes.json")).text());
    await (await import("node:fs/promises")).chmod(join(root, "runtimes.json"), 0o600);
    await Bun.write(join(root, ".keep"), "");
    const registry = new CliRuntimeRegistry(root);
    await expect(registry.resolveSelectedHarness()).resolves.toMatchObject({ runtimeId: legacy.runtimeId, verifiedAdapter: { harnessTools: true } });
  });

  test("旧 Registry 缺失 harnessRuntimeId 时读取回填为原 codex 默认项", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-harness-backfill-")); roots.push(root);
    const legacy = await record(root);
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: { codex: legacy.runtimeId }, runtimes: [legacy] })}\n`);
    await chmod(join(root, "runtimes.json"), 0o600);
    const registry = new CliRuntimeRegistry(root);
    await expect(registry.list()).resolves.toMatchObject({ harnessRuntimeId: legacy.runtimeId });
    await expect(registry.resolveSelectedHarness()).resolves.toMatchObject({ runtimeId: legacy.runtimeId });
  });

  test("harnessRuntimeId 引用不存在的记录时拒绝读取 Registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-harness-dangling-")); roots.push(root);
    const legacy = await record(root);
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: {}, harnessRuntimeId: crypto.randomUUID(), runtimes: [legacy] })}\n`);
    await chmod(join(root, "runtimes.json"), 0o600);
    await expect(new CliRuntimeRegistry(root).list()).rejects.toThrow("Registry 不可读取");
  });

  test("主控可在空闲语义下切换到另一已验证 Runtime，同一选择幂等", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-switch-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const first = await registry.saveVerified(await record(root, "first-codex"));
    const second = await registry.saveVerified({ ...(await record(root, "second-codex")), runtimeId: crypto.randomUUID() });
    await registry.select(first.runtimeId);
    await expect(registry.select(first.runtimeId)).resolves.toMatchObject({ runtimeId: first.runtimeId });
    await expect(registry.select(second.runtimeId)).resolves.toMatchObject({ runtimeId: second.runtimeId });
    await expect(registry.list()).resolves.toMatchObject({ harnessRuntimeId: second.runtimeId });
    await expect(registry.resolveSelectedHarness()).resolves.toMatchObject({ runtimeId: second.runtimeId });
  });

  test("选择时复核安装文件：已删除的 CLI 拒绝设为默认并耐久标 needs-revalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-select-gone-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await record(root, "gone-codex"));
    await rm(saved.executablePath, { force: true });
    await expect(registry.select(saved.runtimeId)).rejects.toThrow("安装文件已被删除或修改");
    const listed = await registry.list();
    expect(listed.harnessRuntimeId).toBeNull();
    expect(listed.runtimes.find(item => item.runtimeId === saved.runtimeId)?.status).toBe("needs-revalidation");
  });

  test("未声明 harnessTools 的 runtime 不能设为主控", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-no-harness-tools-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root,async()=>{throw Error("探针失败");}); const saved = await registry.saveVerified(await kimiRecord(root, "kimi"));
    await expect(registry.select(saved.runtimeId)).rejects.toThrow("主控窄工具");
    await expect(registry.list()).resolves.toMatchObject({ harnessRuntimeId: null });
  });

  test("remove 同时清理指向该 runtime 的 harnessRuntimeId", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-remove-harness-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await record(root));
    await registry.select(saved.runtimeId);
    await registry.remove(saved.runtimeId);
    await expect(new CliRuntimeRegistry(root).list()).resolves.toMatchObject({ harnessRuntimeId: null, selectedByCli: {} });
    await expect(new CliRuntimeRegistry(root).resolveSelectedHarness()).rejects.toThrow("未选择");
  });

  test("旧 kimi 记录在读取时按 Catalog 回填 harnessTools 能力", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-kimi-capability-")); roots.push(root);
    const legacy = await kimiRecord(root, "kimi"); const { harnessTools: _removed, ...adapter } = legacy.verifiedAdapter;
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: {}, runtimes: [{ ...legacy, verifiedAdapter: adapter }] })}\n`);
    await chmod(join(root, "runtimes.json"), 0o600);
    const registry = new CliRuntimeRegistry(root);
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: legacy.runtimeId, verifiedAdapter: { harnessTools: true } }] });
    await registry.select(legacy.runtimeId);
    await expect(registry.resolveSelectedHarness()).resolves.toMatchObject({ runtimeId: legacy.runtimeId, cli: "kimi" });
  });

  test("旧记录携带的废弃 workerEnabled 字段在读取时剥离", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-worker-backfill-")); roots.push(root);
    const first = await record(root);
    const legacy = { ...first, workerEnabled: true } as CliRuntimeRecord & { workerEnabled?: boolean };
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: { codex: first.runtimeId }, runtimes: [legacy] })}\n`);
    await chmod(join(root, "runtimes.json"), 0o600);
    const registry = new CliRuntimeRegistry(root);
    const listed = await registry.list();
    expect(JSON.stringify(listed.runtimes)).not.toContain("workerEnabled");
  });

  test("resolveWorker 的候选为所有已验证 runtime；多候选且无默认项时 fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-resolve-worker-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    // 主控选择同时是该 cli 的 Worker 偏好；harnessTools 仅约束主控，不影响 Worker 候选。
    const harnessCapable = { ...(await kimiRecord(root, "kimi")), verifiedAdapter: { adapterId: "kimi-acp" as const, adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true } };
    const first = await registry.saveVerified(harnessCapable);
    await expect(registry.resolveWorker("kimi")).resolves.toMatchObject({ runtimeId: first.runtimeId, cli: "kimi" });
    await expect(registry.hasWorkerCandidate()).resolves.toBe(true);
    const second = await registry.saveVerified(await kimiRecord(root, "kimi-second"));
    await expect(registry.resolveWorker("kimi")).rejects.toThrow("仅保留一个已验证候选");
    await registry.select(first.runtimeId);
    await expect(registry.resolveWorker("kimi")).resolves.toMatchObject({ runtimeId: first.runtimeId });
    await registry.remove(first.runtimeId);
    await expect(registry.resolveWorker("kimi")).resolves.toMatchObject({ runtimeId: second.runtimeId });
  });

  test("Worker 候选身份漂移时耐久 needs-revalidation 并拒绝启动", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-worker-drift-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await kimiRecord(root, "kimi"));
    await Bun.sleep(5); await writeFile(saved.executablePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(saved.executablePath, 0o700);
    await expect(registry.resolveWorker("kimi")).rejects.toThrow("自动检查失败");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
    await expect(registry.hasWorkerCandidate()).resolves.toBe(false);
  });

  test("kimi runtime 记录解析往返，不携带 node 依赖", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-kimi-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await kimiRecord(root, "kimi"));
    const listed = (await new CliRuntimeRegistry(root).list()).runtimes.find(item => item.runtimeId === saved.runtimeId)!;
    expect(listed).toMatchObject({ cli: "kimi", verifiedAdapter: { adapterId: "kimi-acp", harnessTools: false } });
    expect(JSON.stringify(listed)).not.toContain("nodeExecutable");
    await expect(new CliRuntimeRegistry(root).resolveSelectedHarness()).rejects.toThrow("未选择");
  });

  test("resolveWorkerById 按分配快照直接解析已验证 runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-by-id-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const first = await registry.saveVerified(await kimiRecord(root, "kimi"));
    const second = await registry.saveVerified(await kimiRecord(root, "kimi-second"));
    // 多个同 cli 候选并存时按 id 解析不受偏好与数量影响。
    await expect(registry.resolveWorkerById(second.runtimeId)).resolves.toMatchObject({ runtimeId: second.runtimeId, cli: "kimi" });
    await expect(registry.resolveWorkerById(first.runtimeId)).resolves.toMatchObject({ runtimeId: first.runtimeId });
    await expect(registry.resolveWorkerById(crypto.randomUUID())).rejects.toThrow("不存在或未验证");
  });

  test("resolveWorkerById 身份漂移时耐久 needs-revalidation 并 fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-by-id-drift-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await kimiRecord(root, "kimi"));
    await Bun.sleep(5); await writeFile(saved.executablePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(saved.executablePath, 0o700);
    await expect(registry.resolveWorkerById(saved.runtimeId)).rejects.toThrow("自动检查失败");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
    // 漂移后再次按 id 解析仍拒绝，绝不静默换到另一候选。
    await expect(registry.resolveWorkerById(saved.runtimeId)).rejects.toThrow("自动检查失败");
  });
});

/** 回归：Engine 派发与后台复验均为并发后，Registry 读-改-写必须串行，否则并发
 * saveVerified 相互覆盖丢记录。 */
test("并发 saveVerified 不丢更新", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-concurrent-")); roots.push(root);
  const registry = new CliRuntimeRegistry(root);
  const records = await Promise.all([...Array(8)].map((_, index) => kimiRecord(root, `kimi-${index}`)));
  await Promise.all(records.map((item) => registry.saveVerified(item)));
  const listed = await registry.list();
  expect(listed.runtimes).toHaveLength(8);
  expect(new Set(listed.runtimes.map((item) => item.runtimeId)).size).toBe(8);
});
