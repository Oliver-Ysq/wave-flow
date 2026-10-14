import { describe, expect, test } from "bun:test";
import { adapterById, adapterForCli, workerAdapterForCli } from "../../src/runtimes/adapter-catalog";
import { resolveWorkerLauncher } from "../../src/runtimes/worker-launcher-resolver";
import type { VerifiedCliRuntime } from "../../src/runtimes/types";

const codexRuntime: VerifiedCliRuntime = { runtimeId: "runtime-codex", cli: "codex", executablePath: "/Users/test/.local/bin/codex", executableIdentity: { device: 1, inode: 2, size: 3, modifiedAtMs: 4 }, nodeExecutable: { path: "/Users/test/.nvm/bin/node", identity: { device: 4, inode: 5, size: 6, modifiedAtMs: 7 } }, version: "codex-cli 1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: "2026-10-12T00:00:00.000Z", status: "verified", diagnostic: null };
const kimiRuntime: VerifiedCliRuntime = { runtimeId: "runtime-kimi", cli: "kimi", executablePath: "/Users/test/.kimi-code/bin/kimi", executableIdentity: { device: 1, inode: 8, size: 9, modifiedAtMs: 10 }, version: "kimi 2.1.1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "kimi-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: "2026-10-13T00:00:00.000Z", status: "verified", diagnostic: null };

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

  test("查询接口对未知 adapter 与 cli fail closed", () => {
    expect(adapterById("kimi-acp")?.cli).toBe("kimi");
    expect(adapterById("unknown-acp")).toBeNull();
    expect(workerAdapterForCli("codex")?.adapterId).toBe("codex-acp");
    expect(workerAdapterForCli("traex")).toBeNull();
    // adapter 与 runtime 种类不匹配时拒绝生成 launcher
    expect(() => resolveWorkerLauncher({ ...kimiRuntime, verifiedAdapter: { ...kimiRuntime.verifiedAdapter, adapterId: "codex-acp" } })).toThrow("不可用");
  });
});
