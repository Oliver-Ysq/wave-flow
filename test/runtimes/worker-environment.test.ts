import { expect, test } from "bun:test";
import { createWorkerEnvironment } from "../../src/runtimes/worker-environment";
import type { VerifiedCliRuntime } from "../../src/runtimes/types";

const runtime: VerifiedCliRuntime = { runtimeId: "runtime", cli: "codex", executablePath: "/Users/test/.local/bin/codex", executableIdentity: { device: 1, inode: 2, size: 3, modifiedAtMs: 4 }, nodeExecutable: { path: "/Users/test/.nvm/bin/node", identity: { device: 4, inode: 5, size: 6, modifiedAtMs: 7 } }, version: "codex-cli 1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: "2026-10-12T00:00:00.000Z", status: "verified", diagnostic: null };

test("Worker 环境是最小白名单，只固定注入 runtime 路径", () => {
  const env = createWorkerEnvironment(runtime, { HOME: "/Users/test", PATH: "/custom/bin", SECRET_TOKEN: "hidden", HTTPS_PROXY: "https://proxy", LC_ALL: "zh_CN" });
  expect(env).toMatchObject({ HOME: "/Users/test", CODEX_PATH: runtime.executablePath, NO_BROWSER: "1", HTTPS_PROXY: "https://proxy", LC_ALL: "zh_CN" });
  expect(env.WAVE_FLOW_CONTROL_COMMAND).toBeUndefined();
  expect(env.SECRET_TOKEN).toBeUndefined(); expect(env.PATH).toContain("/usr/bin"); expect(env.PATH.split(":")[0]).toBe("/Users/test/.nvm/bin");
});
