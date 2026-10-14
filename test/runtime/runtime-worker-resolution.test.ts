import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlServer } from "../../src/control/control-server";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import { verifyExecutable } from "../../src/runtimes/identity";
import { AcpWorkerExecutor } from "../../src/runtime/acp-worker-executor";
import { RuntimeAcpWorkerExecutor } from "../../src/runtime/runtime-acp-worker-executor";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { AgentCli } from "../../src/shared/workflow-types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function kimiRecord(root: string): Promise<CliRuntimeRecord> {
  const executablePath = join(root, "kimi"); await writeFile(executablePath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  return { runtimeId: crypto.randomUUID(), cli: "kimi", executablePath: executable.executablePath, executableIdentity: executable.identity, version: "kimi 2.1.1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
}

function node(cli: AgentCli): AgentNodeSnapshot {
  return { id: "node", phase: null, executionAttemptId: 1, phaseVisitId: 1, sequence: 1, executionBatch: { sequence: 1, mode: "serial" }, cli, sandbox: "workspace-write", cwd: "/tmp", label: "node", request: { id: "node", cli, sandbox: "workspace-write", cwd: "/tmp", prompt: "work", phase: undefined }, status: "running", agentSessionId: "session", diagnostic: null, blocked: null, attempts: 1 } as unknown as AgentNodeSnapshot;
}

describe("RuntimeAcpWorkerExecutor 按节点 cli 解析 Worker", () => {
  test("kimi 节点解析到已验证的 kimi runtime 并使用直连 launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-resolve-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const saved = await registry.saveVerified(await kimiRecord(root));
    let launcher: { id: string; command: string; args: readonly string[] } | null = null;
    let provenance: unknown = null;
    const stub = { bindControl() {}, execute: async () => ({ ok: true }), pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, (value, runtime) => { launcher = value; provenance = runtime; return stub as unknown as AcpWorkerExecutor; });
    executor.bindControl({} as ControlServer);
    await expect(executor.execute(node("kimi"))).resolves.toEqual({ ok: true });
    expect(launcher).toMatchObject({ id: "kimi-acp", command: saved.executablePath, args: ["acp"] });
    expect(provenance).toMatchObject({ cli: "kimi", adapterId: "kimi-acp", runtimeId: saved.runtimeId });
  });

  test("无已验证候选时 fail closed，未验证 cli 拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-closed-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    await registry.saveVerified(await kimiRecord(root));
    const stub = { bindControl() {}, execute: async () => ({ ok: true }), pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, () => stub as unknown as AcpWorkerExecutor);
    executor.bindControl({} as ControlServer);
    // 该 cli 下完全没有已验证候选：codex 节点 fail closed
    await expect(executor.execute(node("codex"))).rejects.toThrow("没有已验证");
    // kimi 有恰好一个已验证候选：直接解析成功
    await expect(executor.execute(node("kimi"))).resolves.toEqual({ ok: true });
  });
});

describe("AcpWorkerExecutor cli 门禁", () => {
  test("未知 cli 在任何会话建立前拒绝", async () => {
    const executor = new AcpWorkerExecutor({ id: "fake", command: "fake", args: [] }, () => { throw new Error("不应创建会话"); }, undefined, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never);
    executor.bindControl({} as ControlServer);
    await expect(executor.execute(node("traex" as never))).rejects.toThrow("不支持 cli: traex");
  });
});

/** 携带分配快照指派的节点；assignedRuntimeId 写在生效请求上。 */
function assignedNode(cli: AgentCli, assignedRuntimeId: string): AgentNodeSnapshot {
  const base = node(cli);
  return { ...base, request: { ...base.request, assignedRuntimeId } };
}

/** 最小 Control 边界 stub；hasSession 决定回退是否仍被允许。 */
function controlStub(hasSession: boolean, diagnostics: string[]): ControlServer {
  return {
    hasRecordedNodeSession: () => hasSession,
    recordExecutorDiagnostic: async (message: string) => { diagnostics.push(message); },
  } as unknown as ControlServer;
}

describe("RuntimeAcpWorkerExecutor 分配快照解析与启动前回退", () => {
  test("assignedRuntimeId 优先按分配快照解析，忽略节点字面量 cli", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-assigned-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const kimi = await registry.saveVerified(await kimiRecord(root));
    let provenance: { runtimeId?: string } | null = null;
    const stub = { bindControl() {}, execute: async () => ({ ok: true }), pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, (_launcher, runtime) => { provenance = runtime; return stub as unknown as AcpWorkerExecutor; });
    executor.bindControl(controlStub(false, []));
    // 节点字面量 cli 是 codex，但分配快照指派了 kimi runtime。
    await expect(executor.execute(assignedNode("codex", kimi.runtimeId))).resolves.toEqual({ ok: true });
    expect(provenance).toMatchObject({ runtimeId: kimi.runtimeId, cli: "kimi" });
  });

  test("指派目标不可解析且 session 未建立时回退到主控 Runtime，并耐久诊断", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-fallback-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const fallback = await registry.saveVerified(await kimiRecord(root));
    const diagnostics: string[] = [];
    const used: string[] = [];
    const stub = { bindControl() {}, execute: async () => ({ ok: true }), pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, (_launcher, runtime) => { used.push(runtime.runtimeId ?? ""); return stub as unknown as AcpWorkerExecutor; }, fallback.runtimeId);
    executor.bindControl(controlStub(false, diagnostics));
    await expect(executor.execute(assignedNode("kimi", crypto.randomUUID()))).resolves.toEqual({ ok: true });
    expect(used).toEqual([fallback.runtimeId]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("回退到主控 Runtime");
  });

  test("adapter 启动失败（worker.execute 抛错）在 session 建立前同样允许回退", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-launch-fallback-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const assigned = await registry.saveVerified(await kimiRecord(root));
    const fallbackPath = join(root, "kimi-fallback"); await writeFile(fallbackPath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(fallbackPath, 0o700);
    const fallbackExecutable = await verifyExecutable(fallbackPath);
    const fallback = await registry.saveVerified({ ...assigned, runtimeId: crypto.randomUUID(), executablePath: fallbackExecutable.executablePath, executableIdentity: fallbackExecutable.identity });
    const diagnostics: string[] = [];
    const used: string[] = [];
    const failing = { bindControl() {}, execute: async (): Promise<never> => { throw new Error("ACP 握手失败"); }, pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const stub = { bindControl() {}, execute: async () => ({ ok: true }), pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, (_launcher, runtime) => { used.push(runtime.runtimeId ?? ""); return (runtime.runtimeId === assigned.runtimeId ? failing : stub) as unknown as AcpWorkerExecutor; }, fallback.runtimeId);
    executor.bindControl(controlStub(false, diagnostics));
    await expect(executor.execute(assignedNode("kimi", assigned.runtimeId))).resolves.toEqual({ ok: true });
    expect(used).toEqual([assigned.runtimeId, fallback.runtimeId]);
    expect(diagnostics[0]).toContain("ACP 握手失败");
  });

  test("agent.session 已耐久后失败绝不回退，错误原样上抛", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-no-fallback-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    const assigned = await registry.saveVerified(await kimiRecord(root));
    const fallbackPath = join(root, "kimi-fallback"); await writeFile(fallbackPath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(fallbackPath, 0o700);
    const fallbackExecutable = await verifyExecutable(fallbackPath);
    const fallback = await registry.saveVerified({ ...assigned, runtimeId: crypto.randomUUID(), executablePath: fallbackExecutable.executablePath, executableIdentity: fallbackExecutable.identity });
    const diagnostics: string[] = [];
    const failing = { bindControl() {}, execute: async (): Promise<never> => { throw new Error("投递后 Worker 死亡"); }, pause: async () => {}, recover: async () => ({}), stop: async () => {} };
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, () => failing as unknown as AcpWorkerExecutor, fallback.runtimeId);
    // session 已建立（agent.session 已耐久）：失败只能收敛为 interrupted，不能换 CLI。
    executor.bindControl(controlStub(true, diagnostics));
    await expect(executor.execute(assignedNode("kimi", assigned.runtimeId))).rejects.toThrow("投递后 Worker 死亡");
    expect(diagnostics).toHaveLength(0);
  });

  test("主控回退目标自身不可用则 fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-worker-fallback-closed-")); roots.push(root);
    const registry = new CliRuntimeRegistry(root);
    await registry.saveVerified(await kimiRecord(root));
    const executor = new RuntimeAcpWorkerExecutor(registry, () => ({ name: "private", command: "/mcp", args: [], env: [] }) as never, () => { throw new Error("不应创建 Worker"); }, crypto.randomUUID());
    executor.bindControl(controlStub(false, []));
    await expect(executor.execute(assignedNode("kimi", crypto.randomUUID()))).rejects.toThrow("不存在或未验证");
  });
});
