import { copyFile, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { WorkflowContractError } from "../workflow/errors";

/** Codex独立会话状态目录；生成去除外部工具的私有配置，引用原生登录，不复制凭据；原生目录写权限由Profile声明。 */
export async function prepareCodexSessionHome(scratch: string, original = join(homedir(), ".codex")): Promise<string> {
  const source = await realpath(original), target = join(scratch, "codex-home");
  await mkdir(target, { mode: 0o700 });
  // 只复制模型/provider与shell环境等运行所需配置，删除用户MCP/hooks/插件/项目层，
  // 避免文件型Worker因未授权外部工具启动失败或获得额外副作用通道。
  const configPath = join(source, "config.toml");
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new WorkflowContractError("Codex config.toml必须为当前用户常规文件。");
    const originalConfig = Bun.TOML.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const parsed: Record<string, unknown> = {};
    for (const key of ["model", "model_provider", "model_providers", "model_reasoning_effort", "model_context_window", "model_auto_compact_token_limit", "model_verbosity", "cli_auth_credentials_store"]) {
      if (originalConfig[key] !== undefined) parsed[key] = originalConfig[key];
    }
    // 插件默认启用可能来自来源而非用户条目；必须主动关闭，不靠白名单删除推断。
    parsed.features = { plugins: false };
    parsed.plugins = { _default: { enabled: false } };
    const serialized = Bun.TOML.stringify(parsed);
    if (serialized === undefined) throw new WorkflowContractError("Codex会话配置不可序列化。");
    await writeFile(join(target, "config.toml"), serialized, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // 无用户配置也必须写入同一固定禁用策略，不回到CLI插件默认值。
    await writeFile(join(target, "config.toml"), Bun.TOML.stringify({ features: { plugins: false }, plugins: { _default: { enabled: false } } })!, { mode: 0o600 });
  }
  for (const name of ["auth.json"]) {
    const path = join(source, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new WorkflowContractError(`Codex ${name}必须为当前用户常规文件，拒绝复制或猜测认证来源。`);
      await symlink(path, join(target, name));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

/** Kimi受管会话仅保留默认模型及文件OAuth引用；状态移入私有scratch，不复制凭据、不加载用户hooks/MCP/插件。
 * 当前只验证oauth/kimi-code文件登录；API key与未知认证来源拒绝，不静默改模型/provider。
 */
export async function prepareKimiSessionHome(scratch: string, original = join(homedir(), ".kimi-code")): Promise<string> {
  const source = await realpath(original), target = join(scratch, "kimi-home");
  const configPath = join(source, "config.toml");
  await privateFile(configPath, "Kimi config.toml", false);
  const config = Bun.TOML.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const models = record(config.models), providers = record(config.providers);
  const name = config.default_model;
  if (typeof name !== "string" || !models || !providers) throw new WorkflowContractError("Kimi缺少可核验默认模型配置。");
  const model = record(models[name]), providerName = model?.provider;
  const provider = typeof providerName === "string" ? record(providers[providerName]) : null;
  const oauth = record(provider?.oauth);
  if (!model || !provider || oauth?.storage !== "file" || oauth.key !== "oauth/kimi-code" || provider.api_key || provider.api_key_env || provider.env) throw new WorkflowContractError("Kimi受管会话当前仅验证默认模型的oauth/kimi-code文件认证；其他认证来源拒绝且不切换模型。");
  const credential = join(source, "credentials", "kimi-code.json");
  await privateFile(credential, "Kimi OAuth凭据");
  if (await realpath(credential) !== credential) throw new WorkflowContractError("Kimi OAuth凭据父目录不得为符号链接。");
  // 原生目录由用户授权写入；有效期/刷新由CLI负责，宿主不按短期token阈值拒绝。
  const token = record(JSON.parse(await readFile(credential, "utf8")));
  if (!token || typeof token.access_token !== "string" || !token.access_token.trim() || typeof token.expires_at !== "number" || !Number.isFinite(token.expires_at) || token.expires_at < 0 || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in < 0) throw new WorkflowContractError("Kimi原生登录引用不可验证，请在正常Kimi CLI检查登录后重试。");
  await mkdir(target, { mode: 0o700 });
  // 原生刷新锁与凭据同源，多个会话不各自持独立锁并竞争轮换refresh token。
  await mkdir(join(source, "oauth"), { mode: 0o700, recursive: true });
  if ((await lstat(join(source, "oauth"))).isSymbolicLink() || await realpath(join(source, "oauth")) !== join(source, "oauth")) throw new WorkflowContractError("Kimi原生刷新锁目录不安全。");
  await symlink(join(source, "oauth"), join(target, "oauth"));
  await mkdir(join(target, "empty-skills"), { mode: 0o700 });
  const serialized = Bun.TOML.stringify({ default_model: name, models: { [name]: model }, providers: { [providerName as string]: { type: provider.type, base_url: provider.base_url, oauth } }, ...(config.thinking === undefined ? {} : { thinking: config.thinking }) });
  if (serialized === undefined) throw new WorkflowContractError("Kimi会话配置不可序列化。");
  await writeFile(join(target, "config.toml"), serialized, { mode: 0o600 });
  // 链接整个凭据目录，使CLI的原子temp+rename保存落到原生目录，而非替换单文件软链接。
  await symlink(join(source, "credentials"), join(target, "credentials"));
  // OAuth与凭据写入均由CLI原生管理，宿主不复制或轮换token。
  return target;
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** 用户 dsh home：遵循 CLI 自身 `DSH_HOME ?? ~/.dsh` 契约（仅接受绝对路径）。 */
export function dshHome(): string { const value = process.env.DSH_HOME?.trim(); return value?.startsWith("/") ? value : join(homedir(), ".dsh"); }
/** 用户 Claude 配置目录：遵循 CLI 自身 `CLAUDE_CONFIG_DIR ?? ~/.claude` 契约（仅接受绝对路径）。 */
export function claudeConfigDir(): string { const value = process.env.CLAUDE_CONFIG_DIR?.trim(); return value?.startsWith("/") ? value : join(homedir(), ".claude"); }

/** Claude 主控私有 Home：只保留认证与模型 env，剥离 hooks/statusLine/permissions 等用户扩展。
 * 认证来自 settings.json 的 env 块（兼容端点 token）或独立 `.credentials.json`；两者都只读取，
 * 私有 settings 由宿主以 0600 写入，凭据文件以软链引用，不复制可轮换秘密。
 */
export async function prepareClaudeSessionHome(scratch: string, original = claudeConfigDir()): Promise<string> {
  const source = await realpath(original), target = join(scratch, "claude-home");
  await mkdir(target, { mode: 0o700 });
  const settingsPath = join(source, "settings.json");
  let env: Record<string, string> | undefined;
  try {
    // settings.json 可能含认证 token：拒绝组/其他用户可写的源文件；dotfiles 软链按 realpath 校验。
    const resolvedSettings = await userFile(settingsPath, "Claude settings.json");
    const settings = record(JSON.parse(await readFile(resolvedSettings, "utf8")));
    if (!settings) throw new WorkflowContractError("Claude settings.json 必须是 JSON 对象。");
    const raw = settings.env;
    if (raw !== undefined) {
      const rawEnv = record(raw);
      if (!rawEnv) throw new WorkflowContractError("Claude settings.json 的 env 必须是对象。");
      env = {};
      for (const [key, value] of Object.entries(rawEnv)) if (typeof value === "string") env[key] = value;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const privateSettings: Record<string, unknown> = env === undefined ? {} : { env };
  await writeFile(join(target, "settings.json"), `${JSON.stringify(privateSettings, null, 2)}\n`, { mode: 0o600 });
  // 交互登录方式的独立凭据文件只做软链引用，由 CLI 原生刷新。
  const credentials = join(source, ".credentials.json");
  try {
    // Claude 自身以 0600 写凭据；dotfiles 软链按 realpath 校验后仍要求私有模式。
    const resolvedCredentials = await userFile(credentials, "Claude 凭据", true);
    await symlink(resolvedCredentials, join(target, ".credentials.json"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}

/** dsh 主控私有 Home：复制出厂 profile 骨架并清空用户 patch，使主控不加载用户插件/扩展；
 * 静态 API key 凭据文件以软链引用（dsh 只读取，不轮换），会话状态全部落在私有 Home。
 */
export async function prepareDshSessionHome(scratch: string, original = dshHome()): Promise<string> {
  const source = await realpath(original), target = join(scratch, "dsh-home");
  const profileSource = join(source, "profiles", "acp");
  const skeleton = ["cordis.yml", "package.json", "pnpm-workspace.yaml"];
  for (const name of skeleton) await privateFile(join(profileSource, name), `dsh profile ${name}`, false);
  await mkdir(join(target, "profiles", "acp"), { mode: 0o700, recursive: true });
  for (const name of skeleton) await copyFile(join(profileSource, name), join(target, "profiles", "acp", name));
  // 用户 patch 层必须清空：主控不得继承用户安装的插件与覆盖配置。
  await writeFile(join(target, "profiles", "acp", "cordis.patch.yml"), "# Wave Flow 主控私有 profile：用户 patch 已清空。\n[]\n", { mode: 0o600 });
  try {
    await privateFile(join(source, ".credentials.yaml"), "dsh 凭据");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkflowContractError("未找到 dsh 受管凭证（$DSH_HOME/.credentials.yaml）；请先在 dsh 中配置 API key 后再把 DeepSeek Harness 设为主控。");
    throw error;
  }
  await symlink(join(source, ".credentials.yaml"), join(target, ".credentials.yaml"));
  return target;
}
async function privateFile(path: string, label: string, secret = true): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (secret && (info.mode & 0o077))) throw new WorkflowContractError(`${label}必须为当前用户${secret ? "私有" : "拥有的"}常规文件。`);
}
/** 允许 dotfiles 软链的用户配置文件：按 realpath 校验目标为当前用户常规文件，拒绝组/其他用户可写。 */
async function userFile(path: string, label: string, secret = false): Promise<string> {
  const resolved = await realpath(path);
  const info = await lstat(resolved);
  if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new WorkflowContractError(`${label}必须为当前用户拥有的常规文件。`);
  if (info.mode & 0o022) throw new WorkflowContractError(`${label}不得为组或其他用户可写。`);
  if (secret && (info.mode & 0o077)) throw new WorkflowContractError(`${label}必须为当前用户私有文件。`);
  return resolved;
}
