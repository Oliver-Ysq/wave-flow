import { describe, expect, test } from "bun:test";
import { adapterById, adapterForCli, workerAdapterForCli } from "../../src/runtimes/adapter-catalog";
import { resolveWorkerLauncher } from "../../src/runtimes/worker-launcher-resolver";
import type { VerifiedCliRuntime } from "../../src/runtimes/types";

const codexRuntime: VerifiedCliRuntime = { runtimeId: "runtime-codex", cli: "codex", executablePath: "/Users/test/.local/bin/codex", executableIdentity: { device: 1, inode: 2, size: 3, modifiedAtMs: 4 }, nodeExecutable: { path: "/Users/test/.nvm/bin/node", identity: { device: 4, inode: 5, size: 6, modifiedAtMs: 7 } }, version: "codex-cli 1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: "2026-10-12T00:00:00.000Z", status: "verified", diagnostic: null };
const kimiRuntime: VerifiedCliRuntime = { runtimeId: "runtime-kimi", cli: "kimi", executablePath: "/Users/test/.kimi-code/bin/kimi", executableIdentity: { device: 1, inode: 8, size: 9, modifiedAtMs: 10 }, version: "kimi 2.1.1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: "2026-10-13T00:00:00.000Z", status: "verified", diagnostic: null };
const claudeRuntime: VerifiedCliRuntime = { runtimeId: "runtime-claude", cli: "claude", executablePath: "/Users/test/.nvm/bin/claude", executableIdentity: { device: 1, inode: 11, size: 12, modifiedAtMs: 13 }, nodeExecutable: { path: "/Users/test/.nvm/bin/node", identity: { device: 4, inode: 5, size: 6, modifiedAtMs: 7 } }, version: "2.0.0 (Claude Code)", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "claude-acp", adapterVersion: "0.94.0", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: "2026-10-20T00:00:00.000Z", status: "verified", diagnostic: null };
const dshRuntime: VerifiedCliRuntime = { runtimeId: "runtime-dsh", cli: "dsh", executablePath: "/Users/test/.nvm/bin/dsh", executableIdentity: { device: 1, inode: 14, size: 15, modifiedAtMs: 16 }, nodeExecutable: { path: "/Users/test/.nvm/node24/bin/node", identity: { device: 4, inode: 17, size: 18, modifiedAtMs: 19 } }, version: "0.2.1-rc.2", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "dsh-acp", adapterVersion: "0.0.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: "2026-10-20T00:00:00.000Z", status: "verified", diagnostic: null };

describe("Adapter Catalog", () => {
  test("kimi launcher 直连已验证 realpath，环境不含 CODEX_PATH 或 node", () => {
    const entry = adapterForCli("kimi");
    expect(entry.adapterId).toBe("kimi-acp");
    expect(entry.requiresNodeRuntime).toBe(false);
    expect(entry.capabilities).toEqual({ harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false });
    const launcher = resolveWorkerLauncher(kimiRuntime);
    expect(launcher).toMatchObject({ id: "kimi-acp", command: kimiRuntime.executablePath, args: ["acp"] });
    expect(launcher.env?.CODEX_PATH).toBeUndefined();
    expect(launcher.env?.INITIAL_AGENT_MODE).toBeUndefined();
    expect(launcher.env?.PATH).not.toContain("/Users/test/.nvm/bin");
    expect(launcher.env?.NO_BROWSER).toBe("1");
  });

  test("codex 行为回归：bridge 子进程 + CODEX_PATH + node 依赖", () => {
    const entry = adapterForCli("codex");
    expect(entry.adapterId).toBe("codex-acp");
    expect(entry.requiresNodeRuntime).toBe(true);
    expect(entry.capabilities.harnessTools).toBe(true);
    expect(entry.adapterVersion).toBe("2.2.2");
    const launcher = resolveWorkerLauncher(codexRuntime);
    expect(launcher.id).toBe("codex-acp");
    expect(launcher.command).toBe(process.execPath);
    expect(launcher.env?.CODEX_PATH).toBe(codexRuntime.executablePath);
    expect(launcher.env?.PATH?.split(":")[0]).toBe("/Users/test/.nvm/bin");
  });

  test("claude 条目镜像 codex 模式：bridge 子进程 + CLAUDE_CODE_EXECUTABLE，不强制 node 依赖，版本锁定", () => {
    const entry = adapterForCli("claude");
    expect(entry.adapterId).toBe("claude-acp");
    expect(entry.displayName).toBe("Claude Code");
    expect(entry.requiresNodeRuntime).toBe(false);
    expect(entry.probeMcp).toBe(true);
    expect(entry.adapterVersion).toBe("0.94.0");
    // 主控窄工具经真实隔离 Home + MCP 注入验收后声明。
    expect(entry.capabilities).toEqual({ harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false });
    expect(entry.sessionIsolation?.enabledRoles).toEqual(["harness"]);
    const launcher = resolveWorkerLauncher(claudeRuntime);
    expect(launcher.id).toBe("claude-acp");
    expect(launcher.command).toBe(process.execPath);
    // 开发态必须解析到 bin 入口 dist/index.js；包根 main 是 lib.js（库入口），选错会静默退出零输出。
    expect(launcher.args[0]).toContain("dist/index.js");
    expect(launcher.env?.CLAUDE_CODE_EXECUTABLE).toBe(claudeRuntime.executablePath);
    expect(launcher.env?.PATH?.split(":")[0]).toBe("/Users/test/.nvm/bin");
    expect(launcher.env?.CODEX_PATH).toBeUndefined();
    expect(launcher.env?.NO_BROWSER).toBe("1");
  });

  test("dsh 条目镜像 kimi 模式但要求 Node ≥ 24：realpath + acp argv，adapterVersion 由握手决定", () => {
    const entry = adapterForCli("dsh");
    expect(entry.adapterId).toBe("dsh-acp");
    expect(entry.displayName).toBe("DeepSeek Harness");
    expect(entry.requiresNodeRuntime).toBe(true);
    expect(entry.minNodeVersion).toBe(24);
    expect(entry.probeMcp).toBe(true);
    expect(entry.adapterVersion).toBeNull();
    expect(entry.capabilities).toEqual({ harnessTools: true, workerControlMcp: true, modelOverride: false, modelCatalog: false });
    expect(entry.sessionIsolation?.enabledRoles).toEqual(["harness"]);
    const launcher = resolveWorkerLauncher(dshRuntime);
    expect(launcher).toMatchObject({ id: "dsh-acp", command: dshRuntime.executablePath, args: ["acp"] });
    // dsh shim 经 env node 解析运行时：PATH 必须前置已验证 node 目录；绝不注入 API key 或 CODEX_PATH 类变量。
    expect(launcher.env?.PATH?.split(":")[0]).toBe("/Users/test/.nvm/node24/bin");
    expect(launcher.env?.CODEX_PATH).toBeUndefined();
    expect(launcher.env?.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    expect(launcher.env?.NO_BROWSER).toBe("1");
  });

  test("查询接口对未知 adapter 与 cli fail closed", () => {
    expect(adapterById("kimi-acp")?.cli).toBe("kimi");
    expect(adapterById("unknown-acp")).toBeNull();
    expect(workerAdapterForCli("codex")?.adapterId).toBe("codex-acp");
    expect(workerAdapterForCli("traex")).toBeNull();
    // adapter 与 runtime 种类不匹配时拒绝生成 launcher
    expect(() => resolveWorkerLauncher({ ...kimiRuntime, verifiedAdapter: { ...kimiRuntime.verifiedAdapter, adapterId: "codex-acp" } })).toThrow("不可用");
  });
});
