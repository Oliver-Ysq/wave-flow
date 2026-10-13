import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import { verifyExecutable } from "../../src/runtimes/identity";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function record(root: string): Promise<CliRuntimeRecord> {
  const executablePath = join(root, "codex"); await writeFile(executablePath, "#!/bin/sh\necho codex\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  return { runtimeId: crypto.randomUUID(), cli: "codex", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "codex-cli 1.0", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
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
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-drift-")); roots.push(root); const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await record(root)); await registry.select(saved.runtimeId);
    await Bun.sleep(5); await writeFile(saved.executablePath, "#!/bin/sh\necho changed\n", { mode: 0o700 }); await chmod(saved.executablePath, 0o700);
    await expect(registry.resolveSelected("codex")).rejects.toThrow("已变化");
    await expect(registry.list()).resolves.toMatchObject({ runtimes: [{ runtimeId: saved.runtimeId, status: "needs-revalidation" }] });
  });

  test("node 依赖变化同样持久化 needs-revalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-node-drift-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const saved = await registry.saveVerified(await record(root));
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
    await expect(registry.resolveSelectedHarness("codex")).resolves.toMatchObject({ runtimeId: legacy.runtimeId, verifiedAdapter: { harnessTools: true } });
  });

  test("已有默认主控时拒绝切换到另一 Runtime，但允许原选择幂等确认", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-no-switch-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root); const first = await registry.saveVerified(await record(root));
    const secondPath = join(root, "second-codex"); await writeFile(secondPath, "#!/bin/sh\necho codex\n", { mode: 0o700 }); await chmod(secondPath, 0o700);
    const executable = await verifyExecutable(secondPath);
    const second = await registry.saveVerified({ ...(await record(root)), runtimeId: crypto.randomUUID(), executablePath: executable.executablePath, executableIdentity: executable.identity });
    await registry.select(first.runtimeId);
    await expect(registry.select(second.runtimeId)).rejects.toThrow("后续版本");
    await expect(registry.select(first.runtimeId)).resolves.toMatchObject({ runtimeId: first.runtimeId });
  });
});
