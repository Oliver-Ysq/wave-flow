import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GitCommandError, GitRepository, type GitSavedResult, type GitSaveRequest, type GitDeliveryResult } from "./git-repository";
import type { ExecutionWorkspaceConfig } from "./execution-workspaces";
import { validateExecutionWorkspaces } from "./execution-workspaces";
import { WorkflowContractError } from "../workflow/errors";

/** Git已保存但证据未耐久；允许同请求重试关联，绝不重跑Worker。 */
export class DeliveryPersistenceError extends Error {}

/** 只按宿主错误类型决定重试；契约拒绝不通过解析诊断文本猜测为临时失败。 */
export function isRetryableDeliveryError(error: unknown): boolean {
  return error instanceof DeliveryPersistenceError || error instanceof GitCommandError || !(error instanceof WorkflowContractError);
}

/** 用户冻结的 Git 授权；仅用于受管目录，不允许主工作区提交或推送。 */
export type WorkspaceAuthorization = {
  /** 用户确认请求 UUID；同身份异载荷拒绝。 */
  readonly authorizationId: string;
  /** 用户确认的 ISO 时间，不由 Worker 提供。 */
  readonly approvedAt: string;
  /** canonical 项目仓库根目录。 */
  readonly repository: string;
  /** 明确选择的完整基准 commit，dirty 内容不复制。 */
  readonly baseCommit: string;
  /** false 时存在 tracked/untracked dirty 即拒绝；true 明确只使用已提交基准。 */
  readonly excludeExistingDirty: boolean;
  /** true表示启动确认同时授权最终自动squash；缺省旧授权不生成交付分支。 */
  readonly autoSquashDelivery?: boolean;
  /** 允许自动保存成果的节点与精确文件路径，不支持全目录通配。 */
  readonly nodes: readonly { readonly nodeId: string; readonly paths: readonly string[]; /** 端口/数据库/缓存等外部独占资源。 */ readonly externalResources?: readonly string[] }[];
};

/** 节点成果原始身份；用于关联已有 Run/attempt，不是节点状态 Store。 */
export type WorkspaceNodeIdentity = {
  /** 原 Run UUID。 */
  readonly runId: string;
  /** 原逻辑节点稳定 id。 */
  readonly nodeId: string;
  /** 本次真实执行 attempt，正整数。 */
  readonly attempt: number;
};

/** 写入与 Git 收尾租约；持久锁在 writer 不可核验时不释放。 */
export type WorkspaceLease = WorkspaceNodeIdentity & {
  /** 独立租约 UUID，同一目录不可同时持有两个。 */
  readonly leaseId: string;
  /** 受管工作区 UUID。 */
  readonly workspaceId: string;
  /** writer 启动前的真实 HEAD。 */
  readonly startCommit: string;
  /** 绑定本次 Engine 生命周期，重启不能认领旧 writer。 */
  readonly engineInstanceId: string;
  /** writer 尚未启动为 null；启动后使用可核验的进程组证明身份。 */
  readonly writerIdentity: string | null;
  /** Git不隔离的外部资源键；writer退出并关联成果后才释放。 */
  readonly externalResources: readonly string[];
  /** 由Engine来源门禁核验的额外父commit；普通writer为空。 */
  readonly mergeParents: readonly string[];
};

/** 工作区成果事实；只记录 Git 及锁，不复制业务 complete 状态。 */
export type ManagedWorkspace = {
  /** 工作区 UUID。 */
  readonly workspaceId: string;
  /** canonical 受管 cwd。 */
  readonly cwd: string;
  /** 受管分支短名。 */
  readonly branch: string;
  /** Git 共享元数据身份。 */
  readonly commonDirectory: string;
  /** 当前worktree专属Git元数据；可作为OS隔离的最小Git写例外。 */
  readonly gitDirectory: string;
  /** 冻结的明确授权。 */
  readonly authorization: WorkspaceAuthorization;
  /** 有租约时禁止下一 writer/Git/清理；未知旧 writer 不自动释放。 */
  readonly lease: WorkspaceLease | null;
  /** 保存已耐久的原节点关联，可保留 partial 与 ready 区别。 */
  readonly results: readonly (WorkspaceNodeIdentity & GitSavedResult & { /** 保存起点，核验单节点实际文件范围与commit父链。 */ readonly startCommit: string; /** 集成来源父commit；普通成果为空。 */ readonly mergeParents: readonly string[]; readonly ready: boolean })[];
  /** checkout已安全移除时间；分支/commit/证据仍保留。 */
  readonly cleanedAt: string | null;
  /** 清理前耐久意图；checkout移除后关联失败时按原身份补写，不再删除未知目录。 */
  readonly cleanupRequestedAt: string | null;
};

/** 隔离执行器提供的退出证明；没有证明即不保存、不释放锁。 */
export type WriterVerifier = (lease: WorkspaceLease) => Promise<boolean>;

/** 自动收尾的耐久证据；不改变Execution或节点业务状态。 */
export type WorkspaceDelivery = GitDeliveryResult & {
  /** 已完成的Execution UUID，同时作为幂等请求身份。 */ readonly executionId: string;
  /** 唯一最终ready工作区UUID。 */ readonly sourceWorkspaceId: string;
  /** 冻结授权身份；旧Execution不得使用新的授权补交付。 */ readonly authorizationId: string;
  /** 单父基准完整oid。 */ readonly baseCommit: string;
  /** 证据耐久写入时间，ISO格式。 */ readonly deliveredAt: string;
};

/** Engine 唯一受管 Git 工作区分配器；用户动作与 Runtime 调用都走同一短互斥区。 */
export class WorkspaceManager {
  /** 同状态根目录的多个Execution共享入场仲裁，不能各自独立抢writer/外部资源。 */
  private static readonly mutationTails = new Map<string, Promise<unknown>>();
  private constructor(readonly root: string, readonly engineInstanceId: string) {}

  /** 创建安全状态根目录；重启沿用记录但不认领旧 writer。 */
  static async open(root: string, engineInstanceId: string): Promise<WorkspaceManager> {
    assertUuid(engineInstanceId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail("Workspace Store 必须为当前用户私有真实目录。");
    const canonical = await realpath(root);
    await mkdir(join(canonical, "records"), { mode: 0o700, recursive: true });
    await mkdir(join(canonical, "trees"), { mode: 0o700, recursive: true });
    await mkdir(join(canonical, "scratch"), { mode: 0o700, recursive: true });
    for (const name of ["records", "trees", "scratch"]) {
      const child = await lstat(join(canonical, name));
      if (!child.isDirectory() || child.isSymbolicLink() || (child.mode & 0o077) || (process.getuid && child.uid !== process.getuid())) fail("Workspace子目录必须为当前用户私有真实目录。");
    }
    return new WorkspaceManager(canonical, engineInstanceId);
  }

  /** 建立受管分支；分配身份由调用者保留，响应丢失同身份重试不创建第二分支。 */
  create(workspaceId: string, authorization: WorkspaceAuthorization): Promise<ManagedWorkspace> {
    return this.exclusive(async () => {
      assertUuid(workspaceId); validateAuthorization(authorization);
      const existing = await this.read(workspaceId, true);
      if (existing) { if (!isDeepStrictEqual(existing.authorization, authorization)) fail("工作区请求身份冲突。"); return existing; }
      const repo = await GitRepository.open(authorization.repository);
      const state = await repo.inspect();
      if (state.changedPaths.length && !authorization.excludeExistingDirty) fail("首次基线存在 dirty 内容；请明确选择排除或先处理现场。");
      if (state.head !== authorization.baseCommit) fail("批准后基准 HEAD 已变化；需重新确认基线。");
      const cwd = join(this.root, "trees", workspaceId), branch = `codex/wf-${workspaceId}`;
      // 创建前耐久意图，worktree 已存在时按身份复核后补关联，不另建分支。
      const record: ManagedWorkspace = { workspaceId, cwd, branch, commonDirectory: repo.commonDirectory, gitDirectory: "", authorization, lease: null, results: [], cleanedAt:null, cleanupRequestedAt:null };
      const intentPath = join(this.root, "records", `${workspaceId}.intent`);
      try {
        const info = await lstat(intentPath);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("工作区创建意图文件不安全。");
        if (!isDeepStrictEqual(JSON.parse(await readFile(intentPath, "utf8")), record)) fail("工作区创建意图身份冲突；保留现场。");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.write(workspaceId, record, "intent");
      let worktree: GitRepository;
      try { await lstat(cwd); worktree = await GitRepository.open(cwd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; worktree = await repo.createWorktree(cwd, branch, authorization.baseCommit); }
      const actual = await worktree.inspect();
      if (actual.commonDirectory !== record.commonDirectory || actual.branch !== `refs/heads/${branch}` || actual.head !== authorization.baseCommit || actual.changedPaths.length) fail("工作区创建现场与原意图不一致；保留目录拒绝认领。");
      const completed = { ...record, gitDirectory: actual.gitDirectory };
      await this.write(workspaceId, completed);
      return completed;
    });
  }

  /** 原节点获取同目录独占租约；只有上一成果关联耐久后才允许下一 writer。 */
  acquire(workspaceId: string, identity: WorkspaceNodeIdentity, mergeParents: readonly string[] = []): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      validateIdentity(identity); const record = await this.require(workspaceId);
      if(record.cleanedAt)fail("受管worktree已清理；保留成果分支但不能启动新writer。");
      if(record.cleanupRequestedAt)fail("受管worktree已有耐久清理意图，禁止新writer；请先完成原清理核查。");
      const authorization = record.authorization.nodes.find(node => node.nodeId === identity.nodeId);
      if (!authorization) fail("节点未获成果提交授权。");
      if (record.lease) fail("工作区仍被 writer/Git 租约占用；业务终态或旧PID不是释放依据。");
      const externalResources = authorization.externalResources ?? [];
      if (externalResources.length) for (const name of await readdir(join(this.root, "records"))) {
        if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
        const other = await this.require(name.slice(0, -5));
        if (other.lease?.externalResources.some(resource => externalResources.includes(resource))) fail("外部资源仍被writer占用；Git worktree不隔离端口/数据库/缓存。");
      }
      const repo = await this.repository(record), state = await repo.inspect();
      if (state.changedPaths.length || state.conflicts.length) fail("工作区含未收尾成果或冲突，禁止交接新 writer。");
      if (new Set(mergeParents).size !== mergeParents.length || mergeParents.some(parent => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parent) || parent === state.head)) fail("集成父commit无效或重复。");
      const lease: WorkspaceLease = { ...identity, leaseId: crypto.randomUUID(), workspaceId, startCommit: state.head, engineInstanceId: this.engineInstanceId, writerIdentity: null, externalResources, mergeParents: [...mergeParents] };
      await this.write(workspaceId, { ...record, lease }); return lease;
    });
  }

  /** 必须在真正启动 writer 前耐久绑定由执行器生成的证明身份。 */
  bindWriter(lease: WorkspaceLease, writerIdentity: string): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      const record = await this.requireLease(lease);
      if (lease.engineInstanceId !== this.engineInstanceId || lease.writerIdentity !== null || !writerIdentity.trim()) fail("writer 绑定必须来自本 Engine 的新租约。");
      const bound = { ...lease, writerIdentity }; await this.write(lease.workspaceId, { ...record, lease: bound }); return bound;
    });
  }

  /** 业务 complete 之后保存 ready，或显式停止后保存 partial；退出不自动调用。 */
  finish(lease: WorkspaceLease, ready: boolean, verifyExited: WriterVerifier): Promise<GitSavedResult> {
    return this.exclusive(async () => {
      const record = await this.require(lease.workspaceId);
      const previous = record.results.find(result => result.requestId === lease.leaseId);
      if (previous) {
        if (previous.runId !== lease.runId || previous.nodeId !== lease.nodeId || previous.attempt !== lease.attempt || previous.ready !== ready) fail("已保存成果与请求身份冲突。");
        return { requestId: previous.requestId, commit: previous.commit, paths: previous.paths, unchanged: previous.unchanged };
      }
      if (!isDeepStrictEqual(record.lease, lease)) fail("租约过期或身份不匹配。");
      if (!lease.writerIdentity || !await verifyExited(lease)) fail("原 writer 退出不可核验；保留锁与现场，拒绝保存/交接。");
      const approved = record.authorization.nodes.find(node => node.nodeId === lease.nodeId)!;
      const request: GitSaveRequest = { requestId: lease.leaseId, baseCommit: record.authorization.baseCommit, startCommit: lease.startCommit, allowedPaths: approved.paths, ...(lease.mergeParents.length ? { mergeParents: lease.mergeParents, alternateObjectDirectory: join(this.root, "scratch", lease.leaseId, "objects") } : {}) };
      const result = await (await this.repository(record)).save(request);
      // 保存成功、关联失败时 lease 保留；同请求save核验HEAD与现场并返回同commit。
      const association = { runId: lease.runId, nodeId: lease.nodeId, attempt: lease.attempt, startCommit: lease.startCommit, mergeParents: lease.mergeParents, ...result, ready };
      await this.write(lease.workspaceId, { ...record, lease: null, results: [...record.results, association] });
      return result;
    });
  }

  /** 尚未启动进程的租约可安全撤回；有 writer 记录必须经过退出验证。 */
  abandonUnstarted(lease: WorkspaceLease): Promise<void> {
    return this.exclusive(async () => { const record = await this.requireLease(lease); if (lease.writerIdentity || lease.engineInstanceId !== this.engineInstanceId) fail("不能撤回已启动或旧Engine租约。"); await this.write(lease.workspaceId, { ...record, lease: null }); });
  }

  /** 读取 Git 成果与租约证据，调用者不能据此覆盖业务状态。 */
  async inspect(workspaceId: string): Promise<ManagedWorkspace> { return this.require(workspaceId); }

  /** 只读交付记录；不存在返回null，不在查询中执行Git写入。 */
  async inspectDelivery(executionId: string): Promise<WorkspaceDelivery | null> {
    assertUuid(executionId);
    try {
      const path = join(this.root, "records", `${executionId}.delivery`), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("交付记录不是私有常规文件。");
      const result = JSON.parse(await readFile(path, "utf8")) as WorkspaceDelivery;
      if (result.executionId !== executionId || result.requestId !== executionId || result.branch !== `codex/delivery-${executionId}`) fail("交付记录身份损坏。");
      assertUuid(result.sourceWorkspaceId); assertUuid(result.authorizationId);
      if (![result.commit, result.sourceCommit, result.baseCommit].every(oid => typeof oid === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) || !Array.isArray(result.paths) || result.paths.some(path => typeof path !== "string") || !Number.isFinite(Date.parse(result.deliveredAt))) fail("交付记录字段损坏。");
      return result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  /** 收尾失败的独立耐久诊断；retryable缺省false表示确定性拒绝，true允许下次启动幂等补收尾，不重跑业务。 */
  async recordDeliveryDiagnostic(executionId: string, diagnostic: string, retryable = false): Promise<void> {
    assertUuid(executionId);
    await this.write(executionId, { diagnostic, retryable }, "delivery-error");
  }

  /** 是否允许重启补交付；旧诊断无分类时安全复核一次，确定性拒绝记录false。 */
  async canRetryDelivery(executionId: string): Promise<boolean> {
    await this.inspectDeliveryDiagnostic(executionId);
    try {
      const value = JSON.parse(await readFile(join(this.root, "records", `${executionId}.delivery-error`), "utf8"));
      if (value.retryable !== undefined && typeof value.retryable !== "boolean") fail("交付重试标记损坏。");
      return value.retryable !== false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  }

  private async clearDeliveryDiagnostic(executionId: string): Promise<void> {
    try { await unlink(join(this.root, "records", `${executionId}.delivery-error`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const directory = await open(join(this.root, "records"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  /** 读取既有失败原因；缺失返回null，不触发交付。 */
  async inspectDeliveryDiagnostic(executionId: string): Promise<string | null> {
    assertUuid(executionId);
    try {
      const path = join(this.root, "records", `${executionId}.delivery-error`), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("交付诊断文件不安全。");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (typeof value.diagnostic !== "string") fail("交付诊断损坏。");
      return value.diagnostic;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  /** 启动Git授权包含最终自动交付；调用者必须先确认Execution已completed。actualNodeIds是原Runtime实际写节点集合；生产必传，逐节点验证ready，缺省仅供独立Git核验。 */
  deliverSquash(executionId: string, rawConfig: ExecutionWorkspaceConfig, actualNodeIds?: readonly string[]): Promise<WorkspaceDelivery> {
    return this.exclusive(async () => {
      assertUuid(executionId); const config = validateExecutionWorkspaces(rawConfig);
      if (config.authorization.autoSquashDelivery !== true) fail("启动授权未包含最终自动squash交付。");
      if (actualNodeIds?.some(id => !config.bindings.some(binding => binding.nodeId === id))) fail("实际写节点未授权，不能最终交付。");
      const main = await GitRepository.open(config.authorization.repository);
      const sources: { workspace: ManagedWorkspace; commit: string }[] = [];
      for (const id of new Set(config.bindings.map(binding => binding.workspaceId))) {
        const workspace = await this.require(id);
        const nodeIds = new Set(config.bindings.filter(binding => binding.workspaceId === id).map(binding => binding.nodeId));
        const expected = { ...config.authorization, nodes: config.authorization.nodes.filter(node => nodeIds.has(node.nodeId)) };
        if (!isDeepStrictEqual(workspace.authorization, expected) || workspace.commonDirectory !== main.commonDirectory) fail("交付工作区授权/仓库身份漂移。");
        if (workspace.lease) fail("writer/Git锁仍在，不能最终交付。");
        const results = workspace.results.filter(result => result.runId === executionId);
        for (const nodeId of actualNodeIds?.filter(nodeId => nodeIds.has(nodeId)) ?? []) if (!results.findLast(result => result.nodeId === nodeId)?.ready) fail("实际写节点缺ready成果，不能最终交付。");
        if (!results.length) continue; // 条件分支未实际执行，不伪造其成果。
        const latest = results.at(-1)!;
        if (!latest.ready || workspace.results.at(-1) !== latest) fail("存在partial或后续执行成果，不能交付旧Execution。");
        for (const nodeId of new Set(results.map(result => result.nodeId))) {
          const result = results.findLast(result => result.nodeId === nodeId)!;
          if (!result.ready) fail("存在未完成partial成果，不能最终交付。");
        }
        for (const result of results) {
          const allowed = workspace.authorization.nodes.find(node => node.nodeId === result.nodeId);
          if (!allowed) fail("交付成果缺原节点授权。");
          await main.verifyCommitObject(result.commit, result.startCommit, allowed.paths, result.paths);
        }
        if (!workspace.cleanedAt) await (await this.repository(workspace)).verifySavedCommit(latest.commit, config.authorization.nodes.flatMap(node => node.paths));
        sources.push({ workspace, commit: latest.commit });
      }
      if (!sources.length) fail("没有实际ready写成果，不能最终交付。");
      const candidates = [];
      for (const source of sources) {
        if ((await Promise.all(sources.map(other => main.containsCommit(source.commit, other.commit)))).every(Boolean)) candidates.push(source);
      }
      if (!candidates.length || new Set(candidates.map(source => source.commit)).size !== 1) fail("多个独立分支尚未完整显式集成，不能最终交付。");
      const source = candidates.find(candidate => candidate.workspace.results.some(result => result.runId === executionId && result.ready && result.mergeParents.length > 0)) ?? candidates[0];
      if (sources.length > 1 && !source.workspace.results.some(result => result.runId === executionId && result.ready && result.mergeParents.length > 0)) fail("多个独立分支尚未完整显式集成，不能最终交付。");
      const saved = await main.deliverSquash({ requestId: executionId, baseCommit: config.authorization.baseCommit, sourceCommit: source.commit, allowedPaths: config.authorization.nodes.flatMap(node => node.paths), branch: `codex/delivery-${executionId}` });
      const previous = await this.inspectDelivery(executionId);
      if (previous) {
        if (previous.sourceCommit !== saved.sourceCommit || previous.commit !== saved.commit || previous.authorizationId !== config.authorization.authorizationId || previous.baseCommit !== config.authorization.baseCommit) fail("耐久交付记录与Git证据冲突。");
        try { await this.clearDeliveryDiagnostic(executionId); }
        catch (error) { throw new DeliveryPersistenceError("交付已保存，但旧失败诊断清理未能耐久。", { cause: error }); }
        return previous;
      }
      const result = { ...saved, executionId, sourceWorkspaceId: source.workspace.workspaceId, authorizationId: config.authorization.authorizationId, baseCommit: config.authorization.baseCommit, deliveredAt: new Date().toISOString() };
      try {
        await this.write(executionId, result, "delivery");
        await this.clearDeliveryDiagnostic(executionId);
      } catch (error) { throw new DeliveryPersistenceError(`Git交付已创建，但证据关联未能耐久；可重试宿主收尾：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      return result;
    });
  }

  /** 显式安全清理checkout；不删除分支/commit，不清理partial或未知现场。 */
  cleanup(workspaceId:string,authorized:boolean):Promise<ManagedWorkspace>{return this.exclusive(async()=>{
    if(!authorized)fail("清理worktree必须由用户明确授权。");const record=await this.require(workspaceId);if(record.cleanedAt)return record;
    if(record.lease)fail("writer/Git锁仍在，拒绝清理。");if(!record.results.length||record.results.some(result=>!result.ready))fail("存在partial或未交付成果，拒绝清理。");
    const main=await GitRepository.open(record.authorization.repository);
    const requested=record.cleanupRequestedAt?record:{...record,cleanupRequestedAt:new Date().toISOString()};
    if(!record.cleanupRequestedAt){await this.repository(record);await this.write(workspaceId,requested);}
    try{await lstat(record.cwd);await main.removeWorktree(record.cwd);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      // 只在原清理意图已耐久且分支对象仍可核验时补关联；不按目录缺失猜成果已删除。
      for(const result of record.results){const allowed=record.authorization.nodes.find(node=>node.nodeId===result.nodeId);if(!allowed)fail("清理成果缺原授权。");await main.verifyCommitObject(result.commit,result.startCommit,allowed.paths,result.paths);}
    }
    const cleaned={...requested,cleanedAt:new Date().toISOString()};await this.write(workspaceId,cleaned);return cleaned;
  });}

  /** 为一个writer session创建私有scratch；退出后由执行器清理，不承载成果或授权。 */
  async createScratch(leaseId: string): Promise<string> {
    assertUuid(leaseId); const path = join(this.root, "scratch", leaseId);
    await mkdir(path, { mode: 0o700 });
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) fail("writer scratch不安全。");
    return realpath(path);
  }

  private async repository(record: ManagedWorkspace): Promise<GitRepository> {
    if(record.cleanedAt)fail("受管worktree已清理，仅保留Git成果对象。");
    const repo = await GitRepository.open(record.cwd), state = await repo.inspect();
    if (state.commonDirectory !== record.commonDirectory || state.gitDirectory !== record.gitDirectory || state.branch !== `refs/heads/${record.branch}`) fail("受管工作区Git身份漂移。");
    return repo;
  }
  private async requireLease(lease: WorkspaceLease): Promise<ManagedWorkspace> { const record = await this.require(lease.workspaceId); if (!isDeepStrictEqual(record.lease, lease)) fail("租约过期或身份不匹配。"); return record; }
  private async require(id: string): Promise<ManagedWorkspace> { const record = await this.read(id, false); if (!record) fail("受管工作区不存在。"); return record; }
  private async read(id: string, missing: boolean): Promise<ManagedWorkspace | null> {
    assertUuid(id); const path = join(this.root, "records", `${id}.json`);
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("Workspace记录不是私有常规文件。"); const record = JSON.parse(await readFile(path, "utf8")) as ManagedWorkspace; validateAuthorization(record.authorization); if (record.workspaceId !== id || record.cwd !== join(this.root, "trees", id) || record.branch !== `codex/wf-${id}` || !record.gitDirectory?.startsWith(record.commonDirectory + "/worktrees/") || !Array.isArray(record.results) || (record.cleanedAt!==null&&typeof record.cleanedAt!=="string")) fail("Workspace记录身份损坏。"); return record; }
    catch (error) { if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async write(id: string, value: ManagedWorkspace | WorkspaceDelivery | { diagnostic: string; retryable: boolean }, suffix = "json"): Promise<void> {
    const directory = join(this.root, "records"), file = join(directory, `${id}.${suffix}`), temp = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file); const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const pending = (WorkspaceManager.mutationTails.get(this.root) ?? Promise.resolve()).then(operation); WorkspaceManager.mutationTails.set(this.root, pending.then(() => undefined, () => undefined)); return pending; }
}

function assertUuid(id: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail("Workspace身份必须为UUID。"); }
function validateIdentity(identity: WorkspaceNodeIdentity): void { assertUuid(identity.runId); if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(identity.nodeId) || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1) fail("成果节点身份无效。"); }
function validateAuthorization(value: WorkspaceAuthorization): void {
  assertUuid(value.authorizationId);
  if (!Number.isFinite(Date.parse(value.approvedAt)) || !value.repository.startsWith("/") || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.baseCommit) || typeof value.excludeExistingDirty !== "boolean" || (value.autoSquashDelivery !== undefined && typeof value.autoSquashDelivery !== "boolean") || !Array.isArray(value.nodes) || !value.nodes.length || new Set(value.nodes.map(node => node.nodeId)).size !== value.nodes.length) fail("Workspace授权字段无效。");
  for (const node of value.nodes) { if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(node.nodeId) || !Array.isArray(node.paths) || !node.paths.length || new Set(node.paths).size !== node.paths.length || (node.externalResources !== undefined && (!Array.isArray(node.externalResources) || new Set(node.externalResources).size !== node.externalResources.length || node.externalResources.some((resource: unknown) => typeof resource !== "string" || !/^[a-z0-9][a-z0-9:._/-]{0,119}$/.test(resource))))) fail("Workspace节点授权无效。"); for (const path of node.paths) if (typeof path !== "string" || !path || path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").some((part: string) => !part || part === "." || part === ".." || part === ".git")) fail("Workspace授权文件路径无效。"); }
}
function fail(message: string): never { throw new WorkflowContractError(message); }
