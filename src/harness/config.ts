import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { waveFlowHome } from "../journal/paths";

/** 仅由 daemon 使用的已解析模型配置；apiKey 绝不进入 API 响应、Journal 或日志。 */
export type ResolvedHarnessModelConfig = {
  /** OpenAI-compatible 模型名。 */
  readonly model: string;
  /** OpenAI-compatible 服务根地址。 */
  readonly baseUrl: string;
  /** 仅在当前 daemon 内存中使用的 provider key。 */
  readonly apiKey: string;
};

/** Web 可查看的非敏感配置状态。 */
export type HarnessConfigStatus = { readonly configured: boolean; readonly model: string | null; readonly baseUrl: string | null };

/** 用户从桌面保存的本机配置；文件必须是 owner-only，不能由 Web 直接读取。 */
export async function loadHarnessConfig(): Promise<ResolvedHarnessModelConfig | null> {
  await assertPrivateHome(waveFlowHome());
  const path = configPath();
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Harness 配置文件权限不安全。 ");
    return validate(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") return envConfig();
    throw error;
  }
}

/** 在私有用户目录原子保存配置；key 只在这条 loopback 请求和 daemon 内存出现。 */
export async function saveHarnessConfig(value: ResolvedHarnessModelConfig): Promise<HarnessConfigStatus> {
  const config = validate(value);
  const home = waveFlowHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await assertPrivateHome(home);
  await chmod(home, 0o700);
  const path = configPath();
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await assertPrivateHome(home);
  await rename(temporary, path);
  await chmod(path, 0o600);
  return publicStatus(config);
}

export async function harnessConfigStatus(): Promise<HarnessConfigStatus> { return publicStatus(await loadHarnessConfig()); }
export function publicStatus(config: ResolvedHarnessModelConfig | null): HarnessConfigStatus { return config ? { configured: true, model: config.model, baseUrl: config.baseUrl } : { configured: false, model: null, baseUrl: null }; }

function configPath(): string { return join(waveFlowHome(), "harness-model.json"); }
function envConfig(): ResolvedHarnessModelConfig | null {
  const apiKey = process.env.WAVE_FLOW_HARNESS_API_KEY?.trim();
  if (!apiKey) return null;
  return validate({ apiKey, model: process.env.WAVE_FLOW_HARNESS_MODEL?.trim() || "qwen3.5-122b-a10b", baseUrl: process.env.WAVE_FLOW_HARNESS_BASE_URL?.trim() || "https://ws-c3q8s79jalr0d8e7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" });
}
async function assertPrivateHome(home: string): Promise<void> {
  try {
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === "function" && info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Harness 状态根目录权限不安全。 ");
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
}
function validate(value: unknown): ResolvedHarnessModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Harness 模型配置无效。 ");
  const item = value as Record<string, unknown>;
  if (typeof item.model !== "string" || !item.model.trim() || typeof item.baseUrl !== "string" || typeof item.apiKey !== "string" || !item.apiKey.trim()) throw new Error("Harness 模型配置字段无效。 ");
  let url: URL;
  try { url = new URL(item.baseUrl); } catch { throw new Error("Harness Base URL 无效。 "); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Harness Base URL 只允许 HTTPS，或本机 loopback HTTP，且不能包含凭据、查询或 fragment。 ");
  return { model: item.model.trim(), baseUrl: url.toString().replace(/\/$/, ""), apiKey: item.apiKey.trim() };
}
