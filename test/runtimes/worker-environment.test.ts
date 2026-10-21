import { expect, test } from "bun:test";
import { createClaudeWorkerEnvironment, createDshWorkerEnvironment, createWorkerEnvironment, createKimiWorkerEnvironment } from "../../src/runtimes/worker-environment";
import type { VerifiedCliRuntime } from "../../src/runtimes/types";

const runtime: VerifiedCliRuntime = { runtimeId: "runtime", cli: "codex", executablePath: "/Users/test/.local/bin/codex", executableIdentity: { device: 1, inode: 2, size: 3, modifiedAtMs: 4 }, nodeExecutable: { path: "/Users/test/.nvm/bin/node", identity: { device: 4, inode: 5, size: 6, modifiedAtMs: 7 } }, version: "codex-cli 1", discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: "2026-10-12T00:00:00.000Z", status: "verified", diagnostic: null };

test("Worker 环境是最小白名单，只固定注入 runtime 路径", () => {
  const env = createWorkerEnvironment(runtime, { HOME: "/Users/test", PATH: "/custom/bin", SECRET_TOKEN: "hidden", HTTPS_PROXY: "https://proxy", LC_ALL: "zh_CN" });
  expect(env).toMatchObject({ HOME: "/Users/test", CODEX_PATH: runtime.executablePath, NO_BROWSER: "1", HTTPS_PROXY: "https://proxy", LC_ALL: "zh_CN" });
  expect(env.WAVE_FLOW_CONTROL_COMMAND).toBeUndefined();
  expect(env.SECRET_TOKEN).toBeUndefined(); expect(env.PATH).toContain("/usr/bin"); expect(env.PATH.split(":")[0]).toBe("/Users/test/.nvm/bin");
});

test("双 CLI 共用继承白名单，但专属环境、PATH 和调用间对象仍独立", () => {
  const inherited = { HOME: "/Users/test", USER: "test", LOGNAME: "test", SHELL: "/bin/zsh", TMPDIR: "/private/tmp", LANG: "zh_CN", LC_ALL: "zh_CN", HTTP_PROXY: "http://proxy", SSL_CERT_FILE: "/cert", PATH: "relative:/custom/bin:/custom/bin", SECRET_TOKEN: "hidden", CODEX_PATH: "/untrusted", INITIAL_AGENT_MODE: "untrusted" };
  const codex = createWorkerEnvironment(runtime, inherited);
  const kimi = createKimiWorkerEnvironment({ ...runtime, cli: "kimi" }, inherited);
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "SSL_CERT_FILE", "NO_BROWSER"]) expect(codex[key]).toBe(kimi[key]);
  expect(kimi.CODEX_PATH).toBeUndefined();
  expect(kimi.INITIAL_AGENT_MODE).toBeUndefined();
  expect(kimi.SECRET_TOKEN).toBeUndefined();
  expect(kimi.PATH.split(":")[0]).toBe("/custom/bin");
  expect(kimi.PATH).not.toContain("relative");
  expect(kimi.PATH.split(":").filter(path => path === "/custom/bin")).toHaveLength(1);
  expect(codex.PATH.split(":")[0]).toBe(runtime.nodeExecutable!.path.replace(/\/[^/]+$/, ""));
  expect(createKimiWorkerEnvironment(runtime, inherited)).not.toBe(kimi);
});

test("Claude Worker 环境注入 CLAUDE_CODE_EXECUTABLE 与 node 目录（node 可选），缺 node 不阻塞", () => {
  const inherited = { HOME: "/Users/test", PATH: "/custom/bin", SECRET_TOKEN: "hidden", CLAUDE_CODE_EXECUTABLE: "/untrusted", ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_BASE_URL: "https://untrusted", ANTHROPIC_API_KEY: "secret" };
  const claude = createClaudeWorkerEnvironment({ ...runtime, cli: "claude", executablePath: "/Users/test/.nvm/bin/claude" }, inherited);
  expect(claude.CLAUDE_CODE_EXECUTABLE).toBe("/Users/test/.nvm/bin/claude");
  expect(claude.PATH.split(":")[0]).toBe(runtime.nodeExecutable!.path.replace(/\/[^/]+$/, ""));
  expect(claude.CODEX_PATH).toBeUndefined();
  expect(claude.SECRET_TOKEN).toBeUndefined();
  // 认证只能来自用户自己的 ~/.claude/settings.json（经 HOME 白名单生效），Engine 绝不注入 Anthropic 凭证或端点。
  expect(claude.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(claude.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
  expect(claude.NO_BROWSER).toBe("1");
  // Claude Code 2.x 是原生二进制：没有 node 也必须可用，只是不再前置 node 目录。
  const { nodeExecutable: _node, ...withoutNode } = runtime;
  const noNode = createClaudeWorkerEnvironment({ ...withoutNode, cli: "claude", executablePath: "/Users/test/.local/bin/claude" }, inherited);
  expect(noNode.CLAUDE_CODE_EXECUTABLE).toBe("/Users/test/.local/bin/claude");
  expect(noNode.PATH.split(":")[0]).toBe("/custom/bin");
});

test("dsh Worker 环境只前置已验证 node 目录，绝不注入 API key 或 CLI 路径变量", () => {
  const inherited = { HOME: "/Users/test", PATH: "/custom/bin", DEEPSEEK_API_KEY: "secret", ANTHROPIC_API_KEY: "secret" };
  const dsh = createDshWorkerEnvironment({ ...runtime, cli: "dsh", executablePath: "/Users/test/.nvm/bin/dsh" }, inherited);
  expect(dsh.PATH.split(":")[0]).toBe(runtime.nodeExecutable!.path.replace(/\/[^/]+$/, ""));
  expect(dsh.CODEX_PATH).toBeUndefined();
  expect(dsh.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  expect(dsh.DEEPSEEK_API_KEY).toBeUndefined();
  expect(dsh.ANTHROPIC_API_KEY).toBeUndefined();
  // 未显式设置 DSH_HOME 时由 dsh 自己回退到 ~/.dsh，Engine 不伪造配置。
  expect(dsh.DSH_HOME).toBeUndefined();
  expect(dsh.NO_BROWSER).toBe("1");
  const { nodeExecutable: _node, ...withoutNode } = runtime;
  expect(() => createDshWorkerEnvironment({ ...withoutNode, cli: "dsh" }, inherited)).toThrow("缺少已验证的 node 依赖");
});

test("dsh 显式 DSH_HOME 按 CLI 自身契约透传，相对路径拒绝", () => {
  const absolute = createDshWorkerEnvironment({ ...runtime, cli: "dsh" }, { HOME: "/Users/test", DSH_HOME: "/Users/test/custom-dsh" });
  expect(absolute.DSH_HOME).toBe("/Users/test/custom-dsh");
  const relative = createDshWorkerEnvironment({ ...runtime, cli: "dsh" }, { HOME: "/Users/test", DSH_HOME: "relative/dsh" });
  expect(relative.DSH_HOME).toBeUndefined();
});
