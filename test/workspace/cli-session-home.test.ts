import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClaudeSessionHome, prepareCodexSessionHome, prepareDshSessionHome, prepareKimiSessionHome } from "../../src/workspace/cli-session-home";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test("Codex会话配置去除外部MCP/hooks/plugin，认证仅引用且用户配置不变", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-cli-home-test-")); roots.push(root);
  const original = join(root, "original"), scratch = join(root, "scratch"); await mkdir(original); await mkdir(scratch);
  const config = 'model = "test-model"\nmodel_provider = "proxy"\n[mcp_servers.playwright]\ncommand = "untrusted-tool"\nrequired = true\n[hooks]\nenabled = true\n[plugins]\nenabled = true\n[model_providers.proxy]\nbase_url = "https://example.invalid"\n';
  await writeFile(join(original, "config.toml"), config); await writeFile(join(original, "auth.json"), "test-fixture-not-a-secret", { mode: 0o600 });
  const home = await prepareCodexSessionHome(scratch, original);
  const copied = Bun.TOML.parse(await Bun.file(join(home, "config.toml")).text()) as Record<string, unknown>;
  expect(copied.model).toBe("test-model"); expect(copied.model_providers).toBeDefined(); expect(copied.mcp_servers).toBeUndefined(); expect(copied.hooks).toBeUndefined(); expect(copied.plugins).toEqual({ _default: { enabled: false } }); expect(copied.features).toEqual({ plugins: false });
  expect((await lstat(join(home, "auth.json"))).isSymbolicLink()).toBe(true); expect(await readlink(join(home, "auth.json"))).toBe(join(await import("node:fs/promises").then(fs => fs.realpath(original)), "auth.json"));
  expect(await Bun.file(join(original, "config.toml")).text()).toBe(config); expect((await lstat(join(home, "config.toml"))).mode & 0o077).toBe(0);
});

test("Codex没有用户配置时仍显式关闭插件，不继承来源默认启用", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-cli-home-empty-")); roots.push(root);
  const original = join(root, "original"), scratch = join(root, "scratch"); await mkdir(original); await mkdir(scratch);
  const home = await prepareCodexSessionHome(scratch, original);
  expect(Bun.TOML.parse(await Bun.file(join(home, "config.toml")).text())).toEqual({ features: { plugins: false }, plugins: { _default: { enabled: false } } });
});

async function kimiFixture(provider: Record<string, unknown> = { type: "kimi", base_url: "https://example.invalid", oauth: { storage: "file", key: "oauth/kimi-code" } }) {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-kimi-home-test-")); roots.push(root);
  const original = join(root, "original"), scratch = join(root, "scratch"); await mkdir(original); await mkdir(scratch); await mkdir(join(original, "credentials"));
  const config = Bun.TOML.stringify({ default_model: "test", models: { test: { provider: "managed", model: "test", max_context_size: 1024 } }, providers: { managed: provider, unrelated: { api_key: "fixture-secret-never-copy" } }, hooks: [{ command: "untrusted" }], services: { untrusted: { api_key: "fixture-service-secret" } }, extra_skill_dirs: ["/untrusted"] });
  if (config === undefined) throw new Error("fixture config不可序列化");
  await writeFile(join(original, "config.toml"), config, { mode: 0o600 }); await writeFile(join(original, "credentials", "kimi-code.json"), JSON.stringify({access_token:"fixture-not-secret",refresh_token:"fixture-refresh",expires_at:Math.floor(Date.now()/1000)+3600,expires_in:900}), { mode: 0o600 });
  return { root, original, scratch, config };
}

test("Kimi私有状态配置只含当前默认模型，OAuth使用可刷新原生目录，不复制密钥或用户扩展", async () => {
  const { original, scratch, config } = await kimiFixture();
  await chmod(join(original,"config.toml"),0o644);
  const home = await prepareKimiSessionHome(scratch, original);
  const value = await Bun.file(join(home, "config.toml")).text();
  const parsed = Bun.TOML.parse(value) as Record<string, unknown>;
  expect(parsed.default_model).toBe("test"); expect(parsed.hooks).toBeUndefined(); expect(parsed.services).toBeUndefined(); expect(parsed.extra_skill_dirs).toBeUndefined();
  expect(value).not.toContain("fixture-secret"); expect(value).not.toContain("fixture-service-secret");
  expect((await lstat(join(home, "credentials"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(home, "oauth"))).isSymbolicLink()).toBe(true);
  expect(await Bun.file(join(home, "oauth", "kimi-code")).exists()).toBe(false);
  expect(await readlink(join(home, "credentials"))).toBe(join(await import("node:fs/promises").then(fs => fs.realpath(original)), "credentials"));
  expect(await Bun.file(join(original, "config.toml")).text()).toBe(config);
  expect((await lstat(join(home, "config.toml"))).mode & 0o077).toBe(0);
});

test("Kimi未知认证或凭据符号链接拒绝，不切换默认模型", async () => {
  const api = await kimiFixture({ type: "kimi", api_key: "fixture-key" });
  await expect(prepareKimiSessionHome(api.scratch, api.original)).rejects.toThrow("认证");
  const linked = await kimiFixture();
  await rm(join(linked.original, "credentials", "kimi-code.json"));
  await symlink(join(api.original, "credentials", "kimi-code.json"), join(linked.original, "credentials", "kimi-code.json"));
  await expect(prepareKimiSessionHome(linked.scratch, linked.original)).rejects.toThrow("常规文件");
});

test("Kimi短期token过期不再拒绝，原生CLI可原子刷新凭据而准备阶段不改写",async()=>{
 const {original,scratch}=await kimiFixture();const path=join(original,"credentials","kimi-code.json");const token=JSON.stringify({access_token:"expired-fixture",refresh_token:"fixture",expires_at:1,expires_in:900});await writeFile(path,token,{mode:0o600});
 const home=await prepareKimiSessionHome(scratch,original);expect(await Bun.file(path).text()).toBe(token);expect(await Bun.file(join(home,"config.toml")).exists()).toBe(true);
 const fs=await import("node:fs/promises");await writeFile(join(home,"credentials","new.tmp"),"refreshed",{mode:0o600});await fs.rename(join(home,"credentials","new.tmp"),join(home,"credentials","kimi-code.json"));expect(await Bun.file(path).text()).toBe("refreshed");
});

async function claudeFixture() {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-claude-home-test-")); roots.push(root);
  const original = join(root, "original"), scratch = join(root, "scratch"); await mkdir(original); await mkdir(scratch);
  const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.invalid/anthropic", ANTHROPIC_AUTH_TOKEN: "fixture-not-secret", ANTHROPIC_MODEL: "fixture-model" }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "untrusted" }] }] }, statusLine: { type: "command", command: "untrusted" }, permissions: { allow: ["Bash(*)"] }, mcpServers: { untrusted: { command: "untrusted" } } }, null, 2);
  await writeFile(join(original, "settings.json"), settings, { mode: 0o600 });
  await writeFile(join(original, ".credentials.json"), "fixture-credential-not-secret", { mode: 0o600 });
  return { root, original, scratch, settings };
}

test("Claude私有主控配置只保留认证/模型env，剥离hooks/statusLine/permissions/MCP", async () => {
  const { original, scratch, settings } = await claudeFixture();
  const home = await prepareClaudeSessionHome(scratch, original);
  const privateSettings = JSON.parse(await Bun.file(join(home, "settings.json")).text()) as Record<string, unknown>;
  expect(privateSettings).toEqual({ env: { ANTHROPIC_BASE_URL: "https://example.invalid/anthropic", ANTHROPIC_AUTH_TOKEN: "fixture-not-secret", ANTHROPIC_MODEL: "fixture-model" } });
  expect(privateSettings.hooks).toBeUndefined(); expect(privateSettings.statusLine).toBeUndefined(); expect(privateSettings.permissions).toBeUndefined(); expect(privateSettings.mcpServers).toBeUndefined();
  expect((await lstat(join(home, "settings.json"))).mode & 0o077).toBe(0);
  expect((await lstat(join(home, ".credentials.json"))).isSymbolicLink()).toBe(true);
  expect(await Bun.file(join(original, "settings.json")).text()).toBe(settings);
});

test("Claude settings 允许 0644 与 dotfiles 软链，但拒绝组/其他用户可写", async () => {
  const plain = await claudeFixture();
  await chmod(join(plain.original, "settings.json"), 0o644);
  const home = await prepareClaudeSessionHome(plain.scratch, plain.original);
  expect(JSON.parse(await Bun.file(join(home, "settings.json")).text()).env.ANTHROPIC_MODEL).toBe("fixture-model");

  const writable = await claudeFixture();
  await chmod(join(writable.original, "settings.json"), 0o664);
  await expect(prepareClaudeSessionHome(writable.scratch, writable.original)).rejects.toThrow("可写");

  const linked = await claudeFixture();
  const outside = join(linked.root, "dotfiles-settings.json");
  await writeFile(outside, await Bun.file(join(linked.original, "settings.json")).text(), { mode: 0o600 });
  await rm(join(linked.original, "settings.json"));
  await symlink(outside, join(linked.original, "settings.json"));
  const linkedHome = await prepareClaudeSessionHome(linked.scratch, linked.original);
  expect(JSON.parse(await Bun.file(join(linkedHome, "settings.json")).text()).env.ANTHROPIC_MODEL).toBe("fixture-model");
});

async function dshFixture() {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-dsh-home-test-")); roots.push(root);
  const original = join(root, "original"), scratch = join(root, "scratch");
  const profile = join(original, "profiles", "acp"); await mkdir(profile, { recursive: true }); await mkdir(scratch);
  await writeFile(join(profile, "cordis.yml"), "[]\n");
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-acp", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] } } }));
  await writeFile(join(profile, "pnpm-workspace.yaml"), "");
  await writeFile(join(profile, "cordis.patch.yml"), "- id: user-plugin\n  name: untrusted\n");
  await writeFile(join(original, ".credentials.yaml"), "DEEPSEEK_API_KEY: fixture-not-secret\n", { mode: 0o600 });
  return { root, original, scratch };
}

test("dsh私有主控Home复制出厂骨架并清空用户patch，凭据只软链引用", async () => {
  const { original, scratch } = await dshFixture();
  const home = await prepareDshSessionHome(scratch, original);
  expect(await Bun.file(join(home, "profiles", "acp", "cordis.patch.yml")).text()).toContain("[]");
  expect(await Bun.file(join(home, "profiles", "acp", "cordis.patch.yml")).text()).not.toContain("user-plugin");
  expect(JSON.parse(await Bun.file(join(home, "profiles", "acp", "package.json")).text()).dsh.profile.bundles).toContain("@deepseek-ai/dsh-acp-app");
  expect((await lstat(join(home, ".credentials.yaml"))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(home, ".credentials.yaml"))).toBe(join(await import("node:fs/promises").then(fs => fs.realpath(original)), ".credentials.yaml"));
  expect(await Bun.file(join(original, "profiles", "acp", "cordis.patch.yml")).text()).toContain("user-plugin");
});

test("dsh凭据必须是当前用户私有文件，profile缺失如实拒绝", async () => {
  const wide = await dshFixture();
  await chmod(join(wide.original, ".credentials.yaml"), 0o644);
  await expect(prepareDshSessionHome(wide.scratch, wide.original)).rejects.toThrow("私有");
  const missing = await dshFixture();
  await rm(join(missing.original, "profiles", "acp", "cordis.yml"));
  await expect(prepareDshSessionHome(missing.scratch, missing.original)).rejects.toThrow("ENOENT");
  const noCredentials = await dshFixture();
  await rm(join(noCredentials.original, ".credentials.yaml"));
  await expect(prepareDshSessionHome(noCredentials.scratch, noCredentials.original)).rejects.toThrow("未找到 dsh 受管凭证");
});

test("主控私有 Home 默认位置遵循 DSH_HOME / CLAUDE_CONFIG_DIR 契约", async () => {
  const claude = await claudeFixture();
  const dsh = await dshFixture();
  const previousClaude = process.env.CLAUDE_CONFIG_DIR, previousDsh = process.env.DSH_HOME;
  process.env.CLAUDE_CONFIG_DIR = claude.original; process.env.DSH_HOME = dsh.original;
  try {
    const claudeHome = await prepareClaudeSessionHome(claude.scratch);
    expect(JSON.parse(await Bun.file(join(claudeHome, "settings.json")).text()).env.ANTHROPIC_MODEL).toBe("fixture-model");
    const dshHome = await prepareDshSessionHome(dsh.scratch);
    expect(await Bun.file(join(dshHome, "profiles", "acp", "cordis.yml")).exists()).toBe(true);
  } finally {
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDsh;
  }
});
