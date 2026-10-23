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

async function claudeRecord(root: string, name: string): Promise<CliRuntimeRecord> {
  const executablePath = join(root, name); await writeFile(executablePath, "#!/bin/sh\necho claude\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  return { runtimeId: crypto.randomUUID(), cli: "claude", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "claude 2.1.1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "claude-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
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
    const registry = new CliRuntimeRegistry(root,async()=>{throw Error("探针失败");}); const saved = await registry.saveVerified(await claudeRecord(root, "kimi"));
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

  test("旧 claude 记录在读取时按 Catalog 回填 harnessTools 能力", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-kimi-capability-")); roots.push(root);
    const legacy = await claudeRecord(root, "kimi"); const { harnessTools: _removed, ...adapter } = legacy.verifiedAdapter;
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: {}, runtimes: [{ ...legacy, verifiedAdapter: adapter }] })}\n`);
    await chmod(join(root, "runtimes.json"), 0o600);
    const registry = new CliRuntimeRegistry(root);
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: legacy.runtimeId, verifiedAdapter: { harnessTools: true } }] });
    await registry.select(legacy.runtimeId);
    await expect(registry.resolveSelectedHarness()).resolves.toMatchObject({ runtimeId: legacy.runtimeId, cli: "claude" });
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
    const harnessCapable = { ...(await claudeRecord(root, "kimi")), verifiedAdapter: { adapterId: "claude-acp" as const, adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true } };
    const first = await registry.saveVerified(harnessCapable);
    await expect(registry.resolveWorker("claude")).resolves.toMatchObject({ runtimeId: first.runtimeId, cli: "claude" });
    await expect(registry.hasWorkerCandidate()).resolves.toBe(true);
    const second = await registry.saveVerified(await claudeRecord(root, "kimi-second"));
    await expect(registry.resolveWorker("claude")).rejects.toThrow("仅保留一个已验证候选");
    await registry.select(first.runtimeId);
    await expect(registry.resolveWorker("claude")).resolves.toMatchObject({ runtimeId: first.runtimeId });
    await registry.remove(first.runtimeId);
    await expect(registry.resolveWorker("claude")).resolves.toMatchObject({ runtimeId: second.runtimeId });
  });

  test("Worker 候选身份漂移时耐久 needs-revalidation 并拒绝启动", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-worker-drift-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await claudeRecord(root, "kimi"));
    await Bun.sleep(5); await writeFile(saved.executablePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(saved.executablePath, 0o700);
    await expect(registry.resolveWorker("claude")).rejects.toThrow("自动检查失败");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
    await expect(registry.hasWorkerCandidate()).resolves.toBe(false);
  });

  test("claude runtime 记录解析往返，不携带 node 依赖", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-kimi-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await claudeRecord(root, "kimi"));
    const listed = (await new CliRuntimeRegistry(root).list()).runtimes.find(item => item.runtimeId === saved.runtimeId)!;
    expect(listed).toMatchObject({ cli: "claude", verifiedAdapter: { adapterId: "claude-acp", harnessTools: false } });
    expect(JSON.stringify(listed)).not.toContain("nodeExecutable");
    await expect(new CliRuntimeRegistry(root).resolveSelectedHarness()).rejects.toThrow("未选择");
  });

  test("resolveWorkerById 按分配快照直接解析已验证 runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-by-id-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const first = await registry.saveVerified(await claudeRecord(root, "kimi"));
    const second = await registry.saveVerified(await claudeRecord(root, "kimi-second"));
    // 多个同 cli 候选并存时按 id 解析不受偏好与数量影响。
    await expect(registry.resolveWorkerById(second.runtimeId)).resolves.toMatchObject({ runtimeId: second.runtimeId, cli: "claude" });
    await expect(registry.resolveWorkerById(first.runtimeId)).resolves.toMatchObject({ runtimeId: first.runtimeId });
    await expect(registry.resolveWorkerById(crypto.randomUUID())).rejects.toThrow("不存在或未验证");
  });

  test("resolveWorkerById 身份漂移时耐久 needs-revalidation 并 fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-by-id-drift-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await claudeRecord(root, "kimi"));
    await Bun.sleep(5); await writeFile(saved.executablePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(saved.executablePath, 0o700);
    await expect(registry.resolveWorkerById(saved.runtimeId)).rejects.toThrow("自动检查失败");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
    // 漂移后再次按 id 解析仍拒绝，绝不静默换到另一候选。
    await expect(registry.resolveWorkerById(saved.runtimeId)).rejects.toThrow("自动检查失败");
  });

  test("dsh runtime 记录解析往返：selectedByCli 接受 dsh 键，node 24 复核通过", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-dsh-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const saved = await registry.saveVerified(await dshRecord(root, "dsh", "v24.22.0"));
    // dsh 不声明 harnessTools：不能设为主控，但可作为 Worker 候选按 cli 解析。
    await expect(registry.select(saved.runtimeId)).rejects.toThrow("不能设为主控");
    await expect(registry.resolveWorker("dsh")).resolves.toMatchObject({ runtimeId: saved.runtimeId, cli: "dsh" });
    const listed = await registry.list();
    expect(listed.runtimes[0]).toMatchObject({ cli: "dsh", verifiedAdapter: { adapterId: "dsh-acp", harnessTools: false } });
    expect(JSON.stringify(listed)).not.toContain("inode");
    // Registry 文件校验白名单已拓宽：selectedByCli 的 dsh 键合法且必须引用存在的记录。
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: { dsh: saved.runtimeId }, runtimes: [saved] })}\n`);
    await (await import("node:fs/promises")).chmod(join(root, "runtimes.json"), 0o600);
    expect((await new CliRuntimeRegistry(root).list()).selectedByCli.dsh).toBe(saved.runtimeId);
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: { traex: saved.runtimeId }, runtimes: [saved] })}\n`);
    await (await import("node:fs/promises")).chmod(join(root, "runtimes.json"), 0o600);
    await expect(new CliRuntimeRegistry(root).list()).rejects.toThrow("默认选择无效");
  });

  test("dsh 启动前复核发现 node 主版本低于 24 时触发受控复验并 fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-dsh-old-node-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root, async () => { throw Error("探针失败"); });
    await registry.saveVerified(await dshRecord(root, "dsh", "v22.17.1"));
    await expect(registry.resolveWorker("dsh")).rejects.toThrow("自动检查失败");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ status: "needs-revalidation" }] });
  });
});

/** dsh 记录：requiresNodeRuntime + minNodeVersion，node 由固定打印指定版本的假 node 扮演。 */
async function dshRecord(root: string, name: string, nodeVersion: string): Promise<CliRuntimeRecord> {
  const executablePath = join(root, name); await writeFile(executablePath, "#!/bin/sh\necho dsh\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const nodePath = join(root, `${name}-node`); await writeFile(nodePath, `#!/bin/sh\necho '${nodeVersion}'\n`, { mode: 0o700 }); await chmod(nodePath, 0o700);
  const executable = await verifyExecutable(executablePath); const node = await verifyExecutable(nodePath);
  return { runtimeId: crypto.randomUUID(), cli: "dsh", executablePath: executable.executablePath, executableIdentity: executable.identity, nodeExecutable: { path: node.executablePath, identity: node.identity }, version: "0.2.1-rc.2", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "dsh-acp", adapterVersion: "0.0.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
}

/** 回归：Engine 派发与后台复验均为并发后，Registry 读-改-写必须串行，否则并发
 * saveVerified 相互覆盖丢记录。 */
test("并发 saveVerified 不丢更新", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-concurrent-")); roots.push(root);
  const registry = new CliRuntimeRegistry(root);
  const records = await Promise.all([...Array(8)].map((_, index) => claudeRecord(root, `kimi-${index}`)));
  await Promise.all(records.map((item) => registry.saveVerified(item)));
  const listed = await registry.list();
  expect(listed.runtimes).toHaveLength(8);
  expect(new Set(listed.runtimes.map((item) => item.runtimeId)).size).toBe(8);


});

  test("暂时下线的 kimi 记录保留在磁盘但不进入设置列表", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-kimi-hidden-")); roots.push(root);
    const executablePath = join(root, "kimi"); await writeFile(executablePath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
    const executable = await verifyExecutable(executablePath);
    const legacy: CliRuntimeRecord = { runtimeId: crypto.randomUUID(), cli: "kimi", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "kimi 2.1.1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
    await Bun.write(join(root, "runtimes.json"), `${JSON.stringify({ version: 1, selectedByCli: { kimi: legacy.runtimeId }, harnessRuntimeId: legacy.runtimeId, runtimes: [legacy] })}\n`);
    await chmod(join(root, "runtimes.json"), 0o600);
    const registry = new CliRuntimeRegistry(root);
    const listed = await registry.list();
    expect(listed.runtimes).toEqual([]);
    expect(listed.harnessRuntimeId).toBeNull();
    await expect(registry.resolveSelectedHarness()).rejects.toThrow("支持已暂时下线");
    await expect(registry.resolveByIdHarness(legacy.runtimeId)).rejects.toThrow("支持已暂时下线");
    await expect(registry.resolveWorkerById(legacy.runtimeId)).rejects.toThrow("支持已暂时下线");
    expect(await Bun.file(join(root, "runtimes.json")).text()).toContain(legacy.runtimeId);
  });
