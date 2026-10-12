import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";
import { verifyExecutableIdentity } from "./identity";
import type { CliRuntimeRecord, CliRuntimeRegistryFile, CliRuntimeView, RuntimeCli, VerifiedCliRuntime } from "./types";

/** 用户级 CLI Runtime Registry；只保存确认后的 CLI metadata，绝不保存 shell env 或凭据。 */
export class CliRuntimeRegistry {
  constructor(private readonly root = waveFlowHome()) {}

  async list(): Promise<{ readonly selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>; readonly runtimes: readonly CliRuntimeView[] }> {
    const state = await this.read();
    return { selectedByCli: { ...state.selectedByCli }, runtimes: state.runtimes.map(view) };
  }

  /** 写入或按 canonical executable 去重更新一条已验证 runtime；默认选择仍需用户显式 select。 */
  async saveVerified(record: CliRuntimeRecord): Promise<CliRuntimeRecord> {
    const state = await this.read();
    const index = state.runtimes.findIndex(item => item.executablePath === record.executablePath && item.cli === record.cli);
    const runtimes = [...state.runtimes];
    if (index >= 0) runtimes[index] = { ...record, runtimeId: runtimes[index].runtimeId };
    else runtimes.push(record);
    await this.write({ ...state, runtimes });
    return index >= 0 ? runtimes[index] : record;
  }

  /** 只允许 verified runtime 成为默认执行底座。 */
  async select(runtimeId: string): Promise<CliRuntimeView> {
    const state = await this.read();
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime) throw new Error("未知 CLI Runtime。 ");
    if (runtime.status !== "verified") throw new Error("只有已验证的 CLI Runtime 可以设为默认。 ");
    await this.write({ ...state, selectedByCli: { ...state.selectedByCli, [runtime.cli]: runtime.runtimeId } });
    return view(runtime);
  }

  /** 删除未运行 runtime；历史 Journal 自带 provenance，不依赖 Registry。 */
  async remove(runtimeId: string): Promise<void> {
    const state = await this.read();
    if (!state.runtimes.some(item => item.runtimeId === runtimeId)) throw new Error("未知 CLI Runtime。 ");
    const selectedByCli = { ...state.selectedByCli };
    for (const [cli, selected] of Object.entries(selectedByCli)) if (selected === runtimeId) delete selectedByCli[cli as RuntimeCli];
    await this.write({ ...state, selectedByCli, runtimes: state.runtimes.filter(item => item.runtimeId !== runtimeId) });
  }

  /** 新 Worker 的唯一解析入口；启动前复核 identity，漂移时持久化 needs-revalidation 后 fail closed。 */
  async resolveSelected(cli: RuntimeCli): Promise<VerifiedCliRuntime> {
    const state = await this.read();
    const runtimeId = state.selectedByCli[cli];
    if (!runtimeId) throw new Error("未选择已验证的本机 Codex CLI。请在“执行底座”中扫描、验证并设为默认。 ");
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime || runtime.status !== "verified") throw new Error("当前本机 Codex CLI 不可用，请重新验证。 ");
    try { await verifyExecutableIdentity(runtime.executablePath, runtime.executableIdentity); }
    catch (error) {
      const runtimes = state.runtimes.map(item => item.runtimeId === runtime.runtimeId ? { ...item, status: "needs-revalidation" as const, diagnostic: safeDiagnostic(error) } : item);
      await this.write({ ...state, runtimes });
      throw new Error("当前本机 Codex CLI 已变化，需要重新验证。 ");
    }
    return runtime as VerifiedCliRuntime;
  }

  /** 主控只能使用明确声明 session-scoped Harness tools 能力的 adapter。 */
  async resolveSelectedHarness(cli: RuntimeCli): Promise<VerifiedCliRuntime> {
    const runtime = await this.resolveSelected(cli);
    if (!runtime.verifiedAdapter.harnessTools) throw new Error("当前 CLI Adapter 不支持 Wave Flow 主控窄工具。 ");
    return runtime;
  }

  /** 已有 Harness 续聊按创建时 runtimeId 复核，禁止跟随用户后来切换的默认项。 */
  async resolveByIdHarness(runtimeId: string): Promise<VerifiedCliRuntime> {
    const state = await this.read();
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime || runtime.status !== "verified") throw new Error("该 Harness 创建时使用的本机 CLI 已不可用，请重新验证后新建会话。 ");
    try { await verifyExecutableIdentity(runtime.executablePath, runtime.executableIdentity); }
    catch (error) {
      const runtimes = state.runtimes.map(item => item.runtimeId === runtime.runtimeId ? { ...item, status: "needs-revalidation" as const, diagnostic: safeDiagnostic(error) } : item);
      await this.write({ ...state, runtimes });
      throw new Error("该 Harness 创建时使用的本机 CLI 已变化，需要重新验证并新建会话。 ");
    }
    if (!runtime.verifiedAdapter.harnessTools) throw new Error("该 Harness 创建时使用的 CLI Adapter 不支持主控窄工具。 ");
    return runtime as VerifiedCliRuntime;
  }

  private path(): string { return join(this.root, "runtimes.json"); }
  private async read(): Promise<CliRuntimeRegistryFile> {
    try { await assertPrivateDirectory(this.root); } catch (error) { if (missing(error)) return empty(); throw error; }
    try { const path = this.path(); await assertPrivateFile(path); return parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) { if (missing(error)) return empty(); throw new Error(`CLI Runtime Registry 不可读取：${safeDiagnostic(error)}`); }
  }
  private async write(value: CliRuntimeRegistryFile): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700).catch(() => {});
    const target = this.path(); const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target); await chmod(target, 0o600);
  }
}

function empty(): CliRuntimeRegistryFile { return { version: 1, selectedByCli: {}, runtimes: [] }; }
function view(record: CliRuntimeRecord): CliRuntimeView { const { executableIdentity: _identity, ...safe } = record; return safe; }
function parse(value: unknown): CliRuntimeRegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Registry 格式无效。 ");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !file.selectedByCli || typeof file.selectedByCli !== "object" || !Array.isArray(file.runtimes)) throw new Error("Registry 格式无效。 ");
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const item of file.runtimes) {
    if (!valid(item)) throw new Error("Registry runtime 记录无效。 "); const record = item as CliRuntimeRecord;
    if (ids.has(record.runtimeId) || paths.has(`${record.cli}\0${record.executablePath}`)) throw new Error("Registry runtime 重复。 "); ids.add(record.runtimeId); paths.add(`${record.cli}\0${record.executablePath}`);
  }
  for (const [cli, id] of Object.entries(file.selectedByCli as Record<string, unknown>)) if (cli !== "codex" || typeof id !== "string" || !ids.has(id)) throw new Error("Registry 默认选择无效。 ");
  return { ...(file as unknown as CliRuntimeRegistryFile), runtimes: (file.runtimes as CliRuntimeRecord[]).map(record => ({ ...record, verifiedAdapter: { ...record.verifiedAdapter, harnessTools: record.verifiedAdapter.harnessTools ?? record.verifiedAdapter.adapterId === "codex-acp" } })) };
}
function valid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>; const i = r.executableIdentity as Record<string, unknown>;
  return typeof r.runtimeId === "string" && !!r.runtimeId && r.cli === "codex" && typeof r.executablePath === "string" && r.executablePath.startsWith("/") && !!i && typeof i.device === "number" && typeof i.inode === "number" && typeof i.size === "number" && typeof i.modifiedAtMs === "number" && typeof r.version === "string" && !!r.version && (r.discoveredFrom === "shell-path" || r.discoveredFrom === "gui-path" || r.discoveredFrom === "manual") && (r.discoveredShell === null || typeof r.discoveredShell === "string") && !!r.verifiedAdapter && typeof r.verifiedAdapter === "object" && (r.verifiedAdapter as Record<string, unknown>).adapterId === "codex-acp" && typeof (r.verifiedAdapter as Record<string, unknown>).adapterVersion === "string" && typeof (r.verifiedAdapter as Record<string, unknown>).acpProtocolVersion === "number" && ((r.verifiedAdapter as Record<string, unknown>).harnessTools === undefined || typeof (r.verifiedAdapter as Record<string, unknown>).harnessTools === "boolean") && typeof r.verifiedAt === "string" && !Number.isNaN(Date.parse(r.verifiedAt as string)) && (r.status === "verified" || r.status === "needs-revalidation" || r.status === "invalid") && (r.diagnostic === null || typeof r.diagnostic === "string");
}
async function assertPrivateDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("CLI Runtime 状态目录不安全。 "); }
async function assertPrivateFile(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("CLI Runtime 状态文件不安全。 "); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function safeDiagnostic(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
