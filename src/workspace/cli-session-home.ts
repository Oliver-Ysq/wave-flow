import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
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
async function privateFile(path: string, label: string, secret = true): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (secret && (info.mode & 0o077))) throw new WorkflowContractError(`${label}必须为当前用户${secret ? "私有" : "拥有的"}常规文件。`);
}
