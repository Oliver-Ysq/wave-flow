import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";
import { adapterById, adapterForCli } from "./adapter-catalog";
import { verifyExecutable, verifyExecutableIdentity } from "./identity";
import { validateCliRuntime } from "./cli-runtime-validator";
import { resolveNodeRuntime, verifyNodeRuntime, assertNodeMinimumVersion } from "./node-runtime";
import type { CliRuntimeRecord, CliRuntimeRegistryFile, CliRuntimeView, RuntimeCli, VerifiedCliRuntime } from "./types";
import { cliUnavailableReason, isCliSelectable } from "../shared/cli-availability";

/** 用户级 CLI Runtime Registry；只保存确认后的 CLI metadata，绝不保存 shell env 或凭据。 */
export class CliRuntimeRegistry {
  #revalidations = new Map<string, Promise<VerifiedCliRuntime>>();
  /** 写临界区串行链：Engine stdin 派发为并发，后台复验也与 action 并行；读-改-写不串行会丢更新。 */
  #writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly root = waveFlowHome(),
    /** 完整复验器；生产使用版本/ACP/MCP探针，测试注入，无业务prompt。 */
    private readonly revalidate: typeof validateCliRuntime = validateCliRuntime) {}

  async list(): Promise<{ readonly selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>; readonly leadRuntimeId: string | null; readonly runtimes: readonly CliRuntimeView[] }> {
    const state = await this.read();
    // 暂时下线的 CLI 保留磁盘记录但不出现在产品入口；历史 Journal 仍自带 provenance。
    const visible = state.runtimes.filter(runtime => isCliSelectable(runtime.cli));
    const selectedByCli = Object.fromEntries(Object.entries(state.selectedByCli).filter(([cli]) => isCliSelectable(cli as RuntimeCli))) as Partial<Record<RuntimeCli, string>>;
    const leadRuntimeId = state.leadRuntimeId && visible.some(runtime => runtime.runtimeId === state.leadRuntimeId) ? state.leadRuntimeId : null;
    return { selectedByCli, leadRuntimeId, runtimes: visible.map(view) };
  }

  /** App启动后后台检查原主控；不创建任务、不投递业务Prompt，也不替换默认选择。失败留给用户动作显示。 */
  async refreshSelectedLead():Promise<void> {
    const state=await this.read();
    if(state.leadRuntimeId)await this.resolveSelectedLead();
  }

  /** 串行化读-改-写临界区；长耗时 ACP 复验在锁外完成，只有最终核对与落盘进入锁。 */
  #writeLocked<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(operation, operation);
    this.#writes = run.then(() => {}, () => {});
    return run;
  }

  /** 写入或按 canonical executable 去重更新一条已验证 runtime；默认选择仍需用户显式 select。 */
  async saveVerified(record: CliRuntimeRecord): Promise<CliRuntimeRecord> {
    return this.#writeLocked(async () => {
      const state = await this.read();
      const index = state.runtimes.findIndex(item => item.executablePath === record.executablePath && item.cli === record.cli);
      const runtimes = [...state.runtimes];
      if (index >= 0) runtimes[index] = { ...record, runtimeId: runtimes[index].runtimeId };
      else runtimes.push(record);
      await this.write({ ...state, runtimes });
      return index >= 0 ? runtimes[index] : record;
    });
  }

  /**
   * 用户显式设定主控 runtime；目标必须 verified 且声明 leadTools，同一 id 幂等。
   * 只影响新建主控会话；有回合进行中时的切换由 Engine 空闲检查拒绝，存量会话按
   * 创建时 runtimeId 冻结续聊。同时记录为该 cli 的 Worker 偏好（selectedByCli）。
   */
  async select(runtimeId: string): Promise<CliRuntimeView> {
    return this.#writeLocked(async () => {
      const state = await this.read();
      const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
      if (!runtime) throw new Error("未知 CLI Runtime。 ");
      if (!isCliSelectable(runtime.cli)) throw new Error(cliUnavailableReason(runtime.cli) ?? "该 CLI 已暂时下线。");
      if (runtime.status !== "verified") throw new Error("该 CLI 需要重新验证后才能设为默认。 ");
      if (!runtime.verifiedAdapter.leadTools) throw new Error("该 CLI Adapter 不支持 Wave Flow 主控窄工具，不能设为主控。 ");
      // 身份快速复核：安装在保存后被删除或替换时，不能先写成默认、再等到新建会话
      // 才暴露“当前主控 CLI 不可用”。失败即耐久标 needs-revalidation 并拒绝。
      try { await verifyExecutableIdentity(runtime.executablePath, runtime.executableIdentity); }
      catch (error) {
        await this.write({ ...state, runtimes: state.runtimes.map(item => item.runtimeId === runtime.runtimeId ? { ...item, status: "needs-revalidation" as const, diagnostic: safeDiagnostic(error) } : item) });
        throw new Error("该 CLI 的安装文件已被删除或修改，已标记为需要重新验证；请重新扫描或重新添加。 ");
      }
      await this.write({ ...state, leadRuntimeId: runtime.runtimeId, selectedByCli: { ...state.selectedByCli, [runtime.cli]: runtime.runtimeId } });
      return view(runtime);
    });
  }

  /** 删除未运行 runtime；历史 Journal 自带 provenance，不依赖 Registry。 */
  async remove(runtimeId: string): Promise<void> {
    return this.#writeLocked(async () => {
      const state = await this.read();
      if (!state.runtimes.some(item => item.runtimeId === runtimeId)) throw new Error("未知 CLI Runtime。 ");
      const selectedByCli = { ...state.selectedByCli };
      for (const [cli, selected] of Object.entries(selectedByCli)) if (selected === runtimeId) delete selectedByCli[cli as RuntimeCli];
      const leadRuntimeId = state.leadRuntimeId === runtimeId ? undefined : state.leadRuntimeId;
      await this.write({ ...state, selectedByCli, leadRuntimeId, runtimes: state.runtimes.filter(item => item.runtimeId !== runtimeId) });
    });
  }

  /**
   * 新 Worker 按节点 cli 的唯一解析入口（14.3 前的过渡语义）。
   * 候选 = 该 cli 下所有 verified runtime（已验证即候选，不再有启用开关）；启动前逐一
   * 复核身份，漂移即耐久 needs-revalidation 并拒绝。该 cli 的默认项（selectedByCli）在
   * 候选中优先，恰好一个候选时使用它，多个候选且默认项不在候选中时报错，等待用户在
   * 设置页收敛或由 14.3 指派 UI 解决。
   */
  async resolveWorker(cli: RuntimeCli): Promise<VerifiedCliRuntime> {
    if (!isCliSelectable(cli)) throw new Error(cliUnavailableReason(cli) ?? "该 CLI 已暂时下线。");
    const state = await this.read();
    const candidates = state.runtimes.filter(item => item.cli === cli && item.status !== "invalid");
    if (candidates.length === 0) throw new Error(`没有已验证的本机 ${cli} CLI 可作为 Worker。请在设置页扫描并验证一个 Worker 执行底座。 `);
    const verified: VerifiedCliRuntime[] = [];
    for (const runtime of candidates) {
      try { verified.push(await this.verifyRuntimeDependencies(runtime)); }
      catch (error) {
        await this.markRevalidationFailed(runtime,error);
        throw error;
      }
    }
    const selected = state.selectedByCli[cli];
    const preferred = selected ? verified.find(item => item.runtimeId === selected) : undefined;
    if (preferred) return preferred;
    if (verified.length === 1) return verified[0]!;
    throw new Error(`存在多个已验证的本机 ${cli} Worker 候选；请在设置页仅保留一个已验证候选，或等待指派界面（14.3）。 `);
  }

  /**
   * 分配快照按 runtimeId 的直接解析入口；仅供历史 assigned 配置的指派节点使用。
   * 与 resolveWorker 同一纪律：目标必须 verified，启动前复核身份，漂移即耐久
   * needs-revalidation 并 fail closed，绝不静默换到另一候选。
   */
  async resolveWorkerById(runtimeId: string): Promise<VerifiedCliRuntime> {
    const state = await this.read();
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime || runtime.status === "invalid") throw new Error("分配快照指定的本机 CLI Runtime 不存在或未验证。 ");
    if (!isCliSelectable(runtime.cli)) throw new Error(cliUnavailableReason(runtime.cli) ?? "该 CLI 已暂时下线。");
    try { return await this.verifyRuntimeDependencies(runtime); }
    catch (error) {
      await this.markRevalidationFailed(runtime,error);
      throw error;
    }
  }

  /** Execution/Run 创建前的存在性预检；逐节点仍在调度时按 cli 复核并 fail closed。 */
  async hasWorkerCandidate(): Promise<boolean> {    const state = await this.read();
    return state.runtimes.some(item => item.status === "verified" && isCliSelectable(item.cli));
  }

  /** 按 cli 的用户偏好解析 runtime；启动前复核 identity，漂移时持久化 needs-revalidation 后 fail closed。 */
  async resolveSelected(cli: RuntimeCli): Promise<VerifiedCliRuntime> {
    if (!isCliSelectable(cli)) throw new Error(cliUnavailableReason(cli) ?? "该 CLI 已暂时下线。");
    const state = await this.read();
    const runtimeId = state.selectedByCli[cli];
    if (!runtimeId) throw new Error(`未选择已验证的本机 ${cli} CLI。请在“执行底座”中扫描、验证并设定。 `);
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime || runtime.status === "invalid") throw new Error(`当前本机 ${cli} CLI 不可用，请重新验证。 `);
    let verified: VerifiedCliRuntime;
    try { verified = await this.verifyRuntimeDependencies(runtime); }
    catch (error) {
      await this.markRevalidationFailed(runtime,error);
      throw error;
    }
    return verified;
  }

  /**
   * 新建主控会话的唯一解析入口；只读 leadRuntimeId（与 Worker 池正交）。
   * 已有会话续聊不走这里，由 resolveByIdLead 按创建时 runtimeId 冻结复核。
   */
  async resolveSelectedLead(): Promise<VerifiedCliRuntime> {
    const state = await this.read();
    const runtimeId = state.leadRuntimeId;
    if (!runtimeId) throw new Error("未选择已验证的主控 CLI。请在“执行底座”中扫描、验证并设为主控。 ");
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime || runtime.status === "invalid") throw new Error("当前主控 CLI 不可用，请重新验证。 ");
    if (!isCliSelectable(runtime.cli)) throw new Error(`${cliUnavailableReason(runtime.cli) ?? "该 CLI 已暂时下线。"}请在“执行底座”改选其他 CLI 作为主控。`);
    let verified: VerifiedCliRuntime;
    try { verified = await this.verifyRuntimeDependencies(runtime); }
    catch (error) {
      await this.markRevalidationFailed(runtime,error);
      throw error;
    }
    if (!verified.verifiedAdapter.leadTools) throw new Error("当前主控 CLI Adapter 不支持 Wave Flow 主控窄工具。 ");
    return verified;
  }

  /** 已有 Lead 续聊按创建时 runtimeId 复核，禁止跟随用户后来切换的默认项。 */
  async resolveByIdLead(runtimeId: string): Promise<VerifiedCliRuntime> {
    const state = await this.read();
    const runtime = state.runtimes.find(item => item.runtimeId === runtimeId);
    if (!runtime || runtime.status === "invalid") throw new Error("该 Lead 创建时使用的本机 CLI 已不可用，请重新验证。 ");
    if (!isCliSelectable(runtime.cli)) throw new Error(`${cliUnavailableReason(runtime.cli) ?? "该 CLI 已暂时下线。"}该历史任务不能继续发送新回合，请新建使用其他 CLI 的任务。`);
    let verified: VerifiedCliRuntime;
    try { verified = await this.verifyRuntimeDependencies(runtime); }
    catch (error) {
      await this.markRevalidationFailed(runtime,error);
      throw error;
    }
    if (!verified.verifiedAdapter.leadTools) throw new Error("该 Lead 创建时使用的 CLI Adapter 不支持主控窄工具。 ");
    return verified;
  }

  /** 旧 Registry 首次使用时受控补齐 node 依赖；之后每次启动均按身份复核。kimi 等自包含 CLI 不解析 node。 */
  private async verifyRuntimeDependencies(runtime: CliRuntimeRecord): Promise<VerifiedCliRuntime> {
    try { if(runtime.status!=="verified")throw new Error("需要完整检查");return await this.checkRuntimeDependencies(runtime); }
    catch(error) {
      const pending=this.#revalidations.get(runtime.runtimeId);
      if(pending)return pending;
      const task=this.revalidateSameRuntime(runtime).catch(cause=>{throw new Error(`CLI 或其 node 依赖已变化，自动检查失败：${safeDiagnostic(cause)} 请打开执行底座设置。`);}).finally(()=>this.#revalidations.delete(runtime.runtimeId));
      this.#revalidations.set(runtime.runtimeId,task);
      return task;
    }
  }

  /** 快速身份检查不执行业务；变化时再完整复验同路径，不从候选池选替代CLI。 */
  private async checkRuntimeDependencies(runtime: CliRuntimeRecord): Promise<VerifiedCliRuntime> {
    if (!adapterForCli(runtime.cli).requiresNodeRuntime) {
      await verifyExecutableIdentity(runtime.executablePath, runtime.executableIdentity);
      return { ...runtime, status: "verified" };
    }
    let node = runtime.nodeExecutable;
    if (!node) {
      // 旧记录没有钉 node 时按 Catalog 的版本下限补解析；不能先选默认 node 再断言失败。
      const resolved = await resolveNodeRuntime(runtime.discoveredShell, adapterForCli(runtime.cli).minNodeVersion);
      node = { path: resolved.executablePath, identity: resolved.executableIdentity };
      // 锁内重读再补写：并发 action 或后台复验可能已先更新该记录。
      await this.#writeLocked(async () => {
        const latest = await this.read();
        await this.write({ ...latest, runtimes: latest.runtimes.map(item => item.runtimeId === runtime.runtimeId ? { ...item, nodeExecutable: node } : item) });
      });
    }
    await verifyNodeRuntime(node.path, node.identity);
    // 声明了最低 node 主版本的 CLI（如 dsh）在启动前复核时同步断言版本，防止用户切换 nvm 默认版本后静默退化。
    const minNode = adapterForCli(runtime.cli).minNodeVersion;
    if (minNode !== undefined) await assertNodeMinimumVersion({ executablePath: node.path, executableIdentity: node.identity }, minNode, adapterForCli(runtime.cli).displayName);
    await verifyExecutableIdentity(runtime.executablePath, runtime.executableIdentity);
    return { ...runtime, nodeExecutable: node, status: "verified" };
  }

  private async revalidateSameRuntime(runtime:CliRuntimeRecord):Promise<VerifiedCliRuntime> {
    const current=await verifyExecutable(runtime.executablePath);
    if(current.executablePath!==runtime.executablePath)throw new Error("CLI 路径目标已变化，需要用户确认。");
    if(runtime.nodeExecutable){const node=await verifyExecutable(runtime.nodeExecutable.path);if(node.executablePath!==runtime.nodeExecutable.path)throw new Error("Node 路径目标已变化，需要用户确认。");}
    const checked=await this.revalidate(runtime.cli,{executablePath:runtime.executablePath,discoveredFrom:runtime.discoveredFrom,discoveredShell:runtime.discoveredShell,nodeExecutablePath:runtime.nodeExecutable?.path});
    if(checked.cli!==runtime.cli||checked.executablePath!==runtime.executablePath||checked.verifiedAdapter.adapterId!==runtime.verifiedAdapter.adapterId||runtime.verifiedAdapter.leadTools&&!checked.verifiedAdapter.leadTools||runtime.nodeExecutable&&checked.nodeExecutable?.path!==runtime.nodeExecutable.path)throw new Error("CLI 路径、类型或主控能力已变化，需要用户确认。");
    await verifyExecutableIdentity(checked.executablePath,checked.executableIdentity);
    if(checked.nodeExecutable)await verifyNodeRuntime(checked.nodeExecutable.path,checked.nodeExecutable.identity);
    // 锁内重读核对原记录仍在且未漂移，再落盘复验结果；长耗时握手已在锁外完成。
    return this.#writeLocked(async () => {
      const latest=await this.read();
      const original=latest.runtimes.find(item=>item.runtimeId===runtime.runtimeId);
      if(!original||original.executablePath!==runtime.executablePath)throw new Error("CLI 已移除或修改，自动检查结果已失效。");
      const verified={...checked,runtimeId:runtime.runtimeId,status:"verified" as const,diagnostic:null};
      await this.write({...latest,runtimes:latest.runtimes.map(item=>item.runtimeId===runtime.runtimeId?verified:item)});
      return verified;
    });
  }

  /** 失败只更新原记录，不用探针开始前的旧快照覆盖后来默认选择或删除。 */
  private async markRevalidationFailed(runtime:CliRuntimeRecord,error:unknown):Promise<void> {
    await this.#writeLocked(async () => {
      const latest=await this.read();
      const current=latest.runtimes.find(item=>item.runtimeId===runtime.runtimeId);
      if(!current||current.executablePath!==runtime.executablePath||current.verifiedAt!==runtime.verifiedAt)return;
      await this.write({...latest,runtimes:latest.runtimes.map(item=>item.runtimeId===runtime.runtimeId?{...item,status:"needs-revalidation" as const,diagnostic:safeDiagnostic(error)}:item)});
    });
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
function view(record: CliRuntimeRecord): CliRuntimeView { const { executableIdentity: _identity, nodeExecutable: _node, ...safe } = record; return safe; }
function parse(value: unknown): CliRuntimeRegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Registry 格式无效。 ");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !file.selectedByCli || typeof file.selectedByCli !== "object" || !Array.isArray(file.runtimes)) throw new Error("Registry 格式无效。 ");
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const item of file.runtimes) {
    if (!valid(item)) throw new Error("Registry runtime 记录无效。 "); const record = item as CliRuntimeRecord;
    if (ids.has(record.runtimeId) || paths.has(`${record.cli}\0${record.executablePath}`)) throw new Error("Registry runtime 重复。 "); ids.add(record.runtimeId); paths.add(`${record.cli}\0${record.executablePath}`);
  }
  for (const [cli, id] of Object.entries(file.selectedByCli as Record<string, unknown>)) if ((cli !== "codex" && cli !== "kimi" && cli !== "claude" && cli !== "dsh") || typeof id !== "string" || !ids.has(id)) throw new Error("Registry 默认选择无效。 ");
  if (file.leadRuntimeId !== undefined && (typeof file.leadRuntimeId !== "string" || !ids.has(file.leadRuntimeId))) throw new Error("Registry 主控选择无效。 ");
  const selectedByCli = file.selectedByCli as Partial<Record<RuntimeCli, string>>;
  // 迁移规则：旧文件没有 leadRuntimeId 时回填用户原 codex 默认项，语义不变。
  const leadRuntimeId = (file.leadRuntimeId as string | undefined) ?? selectedByCli["codex"];
  return {
    ...(file as unknown as CliRuntimeRegistryFile),
    leadRuntimeId,
    runtimes: (file.runtimes as Array<CliRuntimeRecord & { workerEnabled?: boolean }>).map(record => {
      // 迁移规则：旧文件的 workerEnabled 字段已废弃（已验证即 Worker 候选），读取时剥离。
      const { workerEnabled: _dropped, ...rest } = record;
      return {
        ...rest,
        // 能力属于 adapter 而非单个二进制：缺失时按 Adapter Catalog 当前声明回填。
        verifiedAdapter: { ...record.verifiedAdapter, leadTools: record.verifiedAdapter.leadTools ?? adapterById(record.verifiedAdapter.adapterId)?.capabilities.leadTools ?? false },
      };
    }),
  };
}
function valid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>; const i = r.executableIdentity as Record<string, unknown>;
  const node = r.nodeExecutable as Record<string, unknown> | undefined;
  const adapter = r.verifiedAdapter as Record<string, unknown> | undefined;
  return typeof r.runtimeId === "string" && !!r.runtimeId && (r.cli === "codex" || r.cli === "kimi" || r.cli === "claude" || r.cli === "dsh") && typeof r.executablePath === "string" && r.executablePath.startsWith("/") && !!i && typeof i.device === "number" && typeof i.inode === "number" && typeof i.size === "number" && typeof i.modifiedAtMs === "number" && (node === undefined || (typeof node.path === "string" && node.path.startsWith("/") && !!node.identity && typeof (node.identity as Record<string, unknown>).device === "number" && typeof (node.identity as Record<string, unknown>).inode === "number" && typeof (node.identity as Record<string, unknown>).size === "number" && typeof (node.identity as Record<string, unknown>).modifiedAtMs === "number")) && typeof r.version === "string" && !!r.version && (r.discoveredFrom === "shell-path" || r.discoveredFrom === "gui-path" || r.discoveredFrom === "install-dir" || r.discoveredFrom === "manual") && (r.discoveredShell === null || typeof r.discoveredShell === "string") && !!adapter && typeof adapter === "object" && (adapter.adapterId === "codex-acp" || adapter.adapterId === "kimi-acp" || adapter.adapterId === "claude-acp" || adapter.adapterId === "dsh-acp") && typeof adapter.adapterVersion === "string" && typeof adapter.acpProtocolVersion === "number" && (adapter.leadTools === undefined || typeof adapter.leadTools === "boolean") && typeof r.verifiedAt === "string" && !Number.isNaN(Date.parse(r.verifiedAt as string)) && (r.status === "verified" || r.status === "needs-revalidation" || r.status === "invalid") && (r.diagnostic === null || typeof r.diagnostic === "string") && (r.workerEnabled === undefined || typeof r.workerEnabled === "boolean");
}
async function assertPrivateDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("CLI Runtime 状态目录不安全。 "); }
async function assertPrivateFile(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("CLI Runtime 状态文件不安全。 "); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function safeDiagnostic(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
