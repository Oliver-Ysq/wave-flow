import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpTransportFactory } from "../../src/adapters/acp-session";
import { validateCliRuntime } from "../../src/runtimes/cli-runtime-validator";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** 真实文件身份 + 假 ACP transport；探针 MCP 的注入在 session/new 参数上断言。 */
async function fakeCli(root: string, name: string, version: string): Promise<string> {
  const path = join(root, name); await writeFile(path, `#!/bin/sh\necho '${version}'\n`, { mode: 0o700 }); await chmod(path, 0o700);
  return path;
}

/** 固定打印指定 `node --version` 输出的假 node；用于确定性覆盖 minNodeVersion 校验，不依赖本机 node 版本。 */
async function fakeNode(root: string, name: string, version: string): Promise<string> {
  return fakeCli(root, name, version);
}

function fakeTransport(hooks: { sessionNewParams?: { mcpServers?: unknown[] }; agentInfo?: { name: string; version: string }; failSession?: boolean }): AcpTransportFactory {
  return async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const app = acp.agent({ name: "fake-acp-agent" })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, agentInfo: hooks.agentInfo }))
      .onRequest(acp.methods.agent.session.new, (context) => {
        hooks.sessionNewParams = context.params as { mcpServers?: unknown[] };
        if (hooks.failSession) throw new Error("session/new 被拒绝。 ");
        return { sessionId: "fake-session" };
      });
    const connection = app.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return { stream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), exited: new Promise<number>(() => {}), close: () => connection.close() };
  };
}

describe("validateCliRuntime / kimi", () => {
  test("握手与 MCP 探针注入成功后返回 kimi-acp 已验证记录，能力取自 Catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-kimi-validate-")); roots.push(root);
    const hooks: { sessionNewParams?: { mcpServers?: unknown[] }; agentInfo?: { name: string; version: string } } = { agentInfo: { name: "kimi", version: "2.1.1" } };
    const record = await validateCliRuntime("kimi", { executablePath: await fakeCli(root, "kimi", "kimi 2.1.1"), discoveredFrom: "manual", discoveredShell: null, createTransport: fakeTransport(hooks) });
    expect(record).toMatchObject({ cli: "kimi", status: "verified", version: "kimi 2.1.1", diagnostic: null });
    expect(record.verifiedAdapter).toEqual({ adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true });
    expect("nodeExecutable" in record).toBe(false);
    // 探针 server 必须真实作为 stdio MCP 注入 session/new，证明 session 私有 MCP 能力。
    expect(hooks.sessionNewParams?.mcpServers).toEqual([expect.objectContaining({ name: "wave-flow-mcp-probe" })]);
  });

  test("握手缺少 agentInfo 时 adapterVersion 回退到 --version 摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-kimi-validate-fallback-")); roots.push(root);
    const record = await validateCliRuntime("kimi", { executablePath: await fakeCli(root, "kimi", "kimi 2.1.1"), discoveredFrom: "manual", discoveredShell: null, createTransport: fakeTransport({}) });
    expect(record.verifiedAdapter.adapterVersion).toBe("kimi 2.1.1");
  });

  test("版本读取失败与握手失败都拒绝且不产生记录", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-kimi-validate-fail-")); roots.push(root);
    const broken = join(root, "kimi-broken"); await writeFile(broken, "#!/bin/sh\nexit 1\n", { mode: 0o700 }); await chmod(broken, 0o700);
    await expect(validateCliRuntime("kimi", { executablePath: broken, discoveredFrom: "manual", discoveredShell: null, createTransport: fakeTransport({}) })).rejects.toThrow("无法读取 Kimi CLI 版本");
    await expect(validateCliRuntime("kimi", { executablePath: await fakeCli(root, "kimi", "kimi 2.1.1"), discoveredFrom: "manual", discoveredShell: null, createTransport: fakeTransport({ failSession: true }) })).rejects.toThrow("Internal error");
    await expect(validateCliRuntime("kimi", { executablePath: join(root, "missing"), discoveredFrom: "manual", discoveredShell: null, createTransport: fakeTransport({}) })).rejects.toThrow("不存在或无法解析");
  });
});

describe("validateCliRuntime / codex", () => {
  test("统一入口同样注入 probe MCP，adapterVersion 取 Catalog 锁定值", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-codex-validate-")); roots.push(root);
    const hooks: { sessionNewParams?: { mcpServers?: unknown[] }; agentInfo?: { name: string; version: string } } = { agentInfo: { name: "codex", version: "9.9.9" } };
    const record = await validateCliRuntime("codex", { executablePath: await fakeCli(root, "codex", "codex-cli 1.0"), discoveredFrom: "manual", discoveredShell: null, createTransport: fakeTransport(hooks) });
    expect(record).toMatchObject({ cli: "codex", status: "verified", version: "codex-cli 1.0", diagnostic: null });
    // adapterVersion 锁定，绝不跟随握手 agentInfo.version。
    expect(record.verifiedAdapter).toEqual({ adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true });
    expect(typeof record.nodeExecutable?.path).toBe("string");
    expect(hooks.sessionNewParams?.mcpServers).toEqual([expect.objectContaining({ name: "wave-flow-mcp-probe" })]);
  }, 20_000);
});

describe("validateCliRuntime / claude", () => {
  test("bridge 入口握手与 MCP 探针成功，adapterVersion 锁定为 0.94.0 不跟随 agentInfo", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-claude-validate-")); roots.push(root);
    const hooks: { sessionNewParams?: { mcpServers?: unknown[] }; agentInfo?: { name: string; version: string } } = { agentInfo: { name: "claude-agent-acp", version: "9.9.9" } };
    const record = await validateCliRuntime("claude", { executablePath: await fakeCli(root, "claude", "2.0.0 (Claude Code)"), discoveredFrom: "manual", discoveredShell: null, nodeExecutablePath: await fakeNode(root, "node", "v22.17.1"), createTransport: fakeTransport(hooks) });
    expect(record).toMatchObject({ cli: "claude", status: "verified", version: "2.0.0 (Claude Code)", diagnostic: null });
    expect(record.verifiedAdapter).toEqual({ adapterId: "claude-acp", adapterVersion: "0.94.0", acpProtocolVersion: 1, harnessTools: true });
    expect(record.nodeExecutable).toBeUndefined();
    expect(hooks.sessionNewParams?.mcpServers).toEqual([expect.objectContaining({ name: "wave-flow-mcp-probe" })]);
  });
});

describe("validateCliRuntime / dsh", () => {
  test("Node ≥ 24 时握手成功，adapterVersion 取握手 agentInfo.version", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-dsh-validate-")); roots.push(root);
    const hooks: { sessionNewParams?: { mcpServers?: unknown[] }; agentInfo?: { name: string; version: string } } = { agentInfo: { name: "dsh", version: "0.0.1" } };
    const record = await validateCliRuntime("dsh", { executablePath: await fakeCli(root, "dsh", "0.2.1-rc.2"), discoveredFrom: "manual", discoveredShell: null, nodeExecutablePath: await fakeNode(root, "node", "v24.22.0"), createTransport: fakeTransport(hooks) });
    expect(record).toMatchObject({ cli: "dsh", status: "verified", version: "0.2.1-rc.2", diagnostic: null });
    expect(record.verifiedAdapter).toEqual({ adapterId: "dsh-acp", adapterVersion: "0.0.1", acpProtocolVersion: 1, harnessTools: true });
    expect(typeof record.nodeExecutable?.path).toBe("string");
    expect(hooks.sessionNewParams?.mcpServers).toEqual([expect.objectContaining({ name: "wave-flow-mcp-probe" })]);
  });

  test("node 主版本低于 minNodeVersion 时验证失败且文案可操作", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-dsh-old-node-")); roots.push(root);
    await expect(validateCliRuntime("dsh", { executablePath: await fakeCli(root, "dsh", "0.2.1-rc.2"), discoveredFrom: "manual", discoveredShell: null, nodeExecutablePath: await fakeNode(root, "node", "v22.17.1"), createTransport: fakeTransport({}) })).rejects.toThrow("DeepSeek Harness 需要 Node ≥ 24");
  });

  test("dsh 在旧 Node 下静默退出零输出时 --version 读取失败，验证拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-dsh-silent-")); roots.push(root);
    const silent = join(root, "dsh"); await writeFile(silent, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(silent, 0o700);
    await expect(validateCliRuntime("dsh", { executablePath: silent, discoveredFrom: "manual", discoveredShell: null, nodeExecutablePath: await fakeNode(root, "node", "v24.22.0"), createTransport: fakeTransport({}) })).rejects.toThrow("无法读取 DeepSeek Harness 版本");
  });
});
