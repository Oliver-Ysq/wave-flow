import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GitCommandError, GitEvidenceLimitError, GitRepository, type GitSavedResult, type GitSealRequest, type GitSourceResult } from "./git-repository";
import type { ExecutionWorkspaceConfig } from "./execution-workspaces";
import { validateExecutionWorkspaces } from "./execution-workspaces";
import { WorkflowContractError } from "../workflow/errors";
import { nodeWriterProcessControl, type WriterProcessControl } from "./writer-process-control";

/** Git已封存但证据未耐久；允许同请求重试关联，绝不重跑Worker。 */
export class SourcePersistenceError extends Error {}

/** 只按宿主错误类型决定重试；契约拒绝不通过解析诊断文本猜测为临时失败。 */
export function isRetryableSourceError(error: unknown): boolean {
  return error instanceof SourcePersistenceError || error instanceof GitCommandError || !(error instanceof WorkflowContractError);
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
  /** 获准在同一受管worktree中工作的写节点；不要求预测最终文件。 */
  readonly nodes: readonly { /** 原Run内稳定节点身份。 */ readonly nodeId: string }[];
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

/** 单个writer的租约；同一worktree可同时存在多个writer，退出核验后逐个释放。 */
export type WorkspaceLease = WorkspaceNodeIdentity & {
  /** 独立租约 UUID；用于核验身份与退出证明，不是节点状态。 */
  readonly leaseId: string;
  /** 共享受管工作区 UUID。 */
  readonly workspaceId: string;
  /** writer 启动前的真实 HEAD；只作诊断，不用于逐节点提交。 */
  readonly startCommit: string;
  /** 绑定本次 Engine 生命周期，重启不能认领旧 writer。 */
  readonly engineInstanceId: string;
  /** writer 尚未启动为 null；启动后使用可核验的进程组证明身份。 */
  readonly writerIdentity: string | null;
  /** writer 进程组 leader PID；未启动为 null。跨 Engine 恢复时用它定位进程组。 */
  readonly writerPgid?: number | null;
  /** 启动时读取的 leader 启动时间指纹；用于区分 PID 复用，未启动为 null。 */
  readonly writerStartedAt?: string | null;
};

/** 绑定 writer 时必须提供的真实进程证据；缺失即拒绝，不留下不可核验的租约。 */
export type WriterBindingEvidence = {
  /** detached 启动的进程组 leader PID（同时是 pgid）。 */
  readonly pgid: number;
  /** leader 启动时间指纹；恢复时比对，不一致视为 PID 复用。 */
  readonly startedAt: string;
};

/** 单条旧租约在恢复期的收尾证据；outcome 是核验结果，不是业务状态。 */
export type ClosedWorkspaceRelease = {
  /** 核验与释放时间。 */
  readonly at: string;
  /** 原租约 UUID。 */
  readonly leaseId: string;
  /** 原节点 id。 */
  readonly nodeId: string;
  /** 原 executionAttempt。 */
  readonly attempt: number;
  /** 判定结果：SIGKILL 终止 / 确认已退出 / 从未启动。 */
  readonly outcome: "killed" | "exited" | "not-started";
  /** 可读原因。 */
  readonly reason: string;
};

/** 工作区成果事实；只记录 Git 及锁，不复制业务 complete 状态。 */
export type ManagedWorkspace = {
  /** 后续Execution独立冻结授权；旧创建authorization永不覆盖，历史缺省为空。 */
  readonly executionAuthorizations?: readonly {
    /** 新获准Execution UUID，旧Run不能借用此权限。 */ readonly executionId: string;
    /** 本轮独立冻结的节点授权，旧授权不覆盖。 */ readonly authorization: WorkspaceAuthorization;
    /** 接管时原现场完整commit，恢复不退回历史文件。 */ readonly startCommit: string;
    /** 续作前驱Execution；首次新目录省略，不从最新结果猜原确认。 */ readonly previousExecutionId?: string;
  }[];
  /** 工作区 UUID。 */
  readonly workspaceId: string;
  /** canonical 受管 cwd。 */
  readonly cwd: string;
  /** 受管分支短名。 */
  readonly branch: string;
  /** Git 共享元数据身份。 */
  readonly commonDirectory: string;
  /** 当前worktree专属Git元数据；用于核验Git身份。 */
  readonly gitDirectory: string;
  /** 冻结的明确授权。 */
  readonly authorization: WorkspaceAuthorization;
  /** 当前仍存活的writer租约；多写者共享同一目录。 */
  readonly leases: readonly WorkspaceLease[];
  /** 恢复前已终止并核验的旧 Engine 租约证据；每条都记录判定结果。 */
  readonly closedReleases?: readonly ClosedWorkspaceRelease[];
  /** 最近一次成功写入主工作区的封存commit；用于允许接续执行在完全相同的未提交现场上更新。 */
  readonly lastApplied?: { /** 写入的Execution UUID。 */ readonly executionId: string; /** 已写入的封存commit。 */ readonly commit: string; /** 写入时间。 */ readonly at: string };
  /** 自动应用的耐久意图；崩溃或Git失败后用于识别宿主自己的部分改动，不误判为用户现场。 */
  readonly applyIntent?: {
    /** 正在应用的Execution UUID。 */ readonly executionId: string;
    /** 目标封存commit。 */ readonly commit: string;
    /** 应用前期望的主工作区现场（上一次应用结果）；首次应用省略。 */ readonly expectedWorktree?: string;
    /** 意图耐久时间，ISO格式。 */ readonly at: string;
  };
  /** checkout已安全移除时间；分支/commit/证据仍保留。 */
  readonly cleanedAt: string | null;
  /** 清理前耐久意图；checkout移除后关联失败时按原身份补写，不再删除未知目录。 */
  readonly cleanupRequestedAt: string | null;
};

/** owned ACP执行器提供的退出证明；没有证明即不释放锁。 */
export type WriterVerifier = (lease: WorkspaceLease) => Promise<boolean>;

/** 最终自动应用状态；失败只记录原因，不覆盖用户现场。 */
export type WorkspaceApplyState =
  | { /** 已写入主工作区的时间。 */ readonly at: string; /** 实际写入路径；与封存diff一致。 */ readonly paths: readonly string[] }
  | { /** 未能自动应用的时间。 */ readonly skippedAt: string; /** 用户可读原因；不代表业务失败。 */ readonly reason: string };

/** 一次Execution的最终封存与自动应用证据；不移动主分支引用。 */
export type WorkspaceSource = GitSourceResult & {
  /** 已完成的Execution UUID，同时作为幂等请求身份。 */ readonly executionId: string;
  /** 唯一受管工作区UUID。 */ readonly workspaceId: string;
  /** 冻结授权身份；旧Execution不得使用新的授权补交付。 */ readonly authorizationId: string;
  /** 冻结基准完整oid。 */ readonly baseCommit: string;
  /** 最终封存commit。 */ readonly commit: string;
  /** 相对基准的全部变更路径，供变更面板展示。 */ readonly paths: readonly string[];
  /** 主工作区自动应用结果；未应用时保留原因。 */ readonly applied: WorkspaceApplyState;
  /** 证据耐久写入时间，ISO格式。 */ readonly savedAt: string;
};

/** Engine 唯一受管 Git 工作区分配器；用户动作与 Runtime 调用都走同一短互斥区。 */
export class WorkspaceManager {
  /** 同状态根目录的多个Execution共享入场仲裁，不能各自独立抢writer/外部资源。 */
  private static readonly mutationTails = new Map<string, Promise<unknown>>();
  readonly #control: WriterProcessControl;
  private constructor(readonly root: string, readonly engineInstanceId: string, control: WriterProcessControl) { this.#control = control; }

  /** 创建安全状态根目录；重启沿用记录但不认领旧 writer。 */
  static async open(root: string, engineInstanceId: string, control: WriterProcessControl = nodeWriterProcessControl()): Promise<WorkspaceManager> {
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
    return new WorkspaceManager(canonical, engineInstanceId, control);
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
      const record: ManagedWorkspace = { workspaceId, cwd, branch, commonDirectory: repo.commonDirectory, gitDirectory: "", authorization, leases: [], cleanedAt: null, cleanupRequestedAt: null };
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

  /**
   * 写节点取得共享worktree租约；同目录可并行持有多个writer。
   * 只有未解决冲突、已清理或沿用更旧Execution时才拒绝；不再因目录已有改动拒绝。
   */
  acquire(workspaceId: string, identity: WorkspaceNodeIdentity): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      validateIdentity(identity); const record = await this.require(workspaceId);
      if (record.executionAuthorizations?.length && record.executionAuthorizations.at(-1)!.executionId !== identity.runId) fail("工作区已交接较新Execution，旧执行不能重新取得writer。");
      if (record.cleanedAt) fail("受管worktree已清理；保留成果分支但不能启动新writer。");
      if (record.cleanupRequestedAt) fail("受管worktree已有耐久清理意图，禁止新writer；请先完成原清理核查。");
      const authorization = this.authorizationFor(record, identity.runId).nodes.find(node => node.nodeId === identity.nodeId);
      if (!authorization) fail("节点未获成果提交授权。");
      const repo = await this.repository(record), state = await repo.inspect();
      if (state.conflicts.length) fail("工作区存在未解决冲突，禁止启动writer；请先处理现场。");
      const handover = record.executionAuthorizations?.find(item => item.executionId === identity.runId);
      if (handover && state.head !== handover.startCommit && !(await repo.containsCommit(state.head, handover.startCommit))) fail("已交接现场HEAD被外部修改，拒绝启动writer，不自动回滚。");
      const lease: WorkspaceLease = { ...identity, leaseId: crypto.randomUUID(), workspaceId, startCommit: state.head, engineInstanceId: this.engineInstanceId, writerIdentity: null };
      await this.write(workspaceId, { ...record, leases: [...record.leases, lease] }); return lease;
    });
  }

  /**
   * 必须在真正启动 writer 前耐久绑定由执行器生成的证明身份与进程证据。
   *
   * 证据是必填参数而不是可选：每条已绑定租约都必须能在跨 Engine 恢复时被定位和
   * 核验；漏传会在编译期失败，不会等到用户恢复时才以"缺少进程证据"暴露。
   */
  bindWriter(lease: WorkspaceLease, writerIdentity: string, evidence: WriterBindingEvidence): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      const record = await this.requireLease(lease);
      if (lease.engineInstanceId !== this.engineInstanceId || lease.writerIdentity !== null || !writerIdentity.trim()) fail("writer 绑定必须来自本 Engine 的新租约。");
      if (!Number.isSafeInteger(evidence.pgid) || evidence.pgid <= 1 || !evidence.startedAt.trim()) fail("writer 绑定缺少可核验的进程证据。");
      const bound = { ...lease, writerIdentity, writerPgid: evidence.pgid, writerStartedAt: evidence.startedAt };
      await this.write(lease.workspaceId, { ...record, leases: record.leases.map(item => item.leaseId === lease.leaseId ? bound : item) }); return bound;
    });
  }

  /** 节点结束（完成或停止）后核验writer退出并释放租约；改动保留在共享worktree。 */
  release(lease: WorkspaceLease, verifyExited: WriterVerifier): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.require(lease.workspaceId);
      const current = record.leases.find(item => item.leaseId === lease.leaseId);
      if (!current || !isDeepStrictEqual(current, lease)) fail("租约过期或身份不匹配。");
      if (!lease.writerIdentity || !await verifyExited(lease)) fail("原 writer 退出不可核验；保留锁与现场，拒绝交接。");
      await this.write(lease.workspaceId, { ...record, leases: record.leases.filter(item => item.leaseId !== lease.leaseId) });
    });
  }

  /** 尚未启动进程的租约可安全撤回；有 writer 记录必须经过退出验证。 */
  abandonUnstarted(lease: WorkspaceLease): Promise<void> {
    return this.exclusive(async () => { const record = await this.requireLease(lease); if (lease.writerIdentity || lease.engineInstanceId !== this.engineInstanceId) fail("不能撤回已启动或旧Engine租约。"); await this.write(lease.workspaceId, { ...record, leases: record.leases.filter(item => item.leaseId !== lease.leaseId) }); });
  }

  /** 读取 Git 成果与租约证据，调用者不能据此覆盖业务状态。 */
  async inspect(workspaceId: string): Promise<ManagedWorkspace> { return this.require(workspaceId); }

  /** 已链接新Execution的明确交接；共享worktree按原HEAD接续，不回滚历史文件。 */
  prepareExecution(executionId: string, rawConfig: ExecutionWorkspaceConfig): Promise<void> {
    return this.exclusive(async () => {
      assertUuid(executionId);
      const config = validateExecutionWorkspaces(rawConfig), main = await GitRepository.open(config.authorization.repository);
      const record = await this.require(config.workspaceId), authorization = config.authorization;
      const existing = record.executionAuthorizations?.find(item => item.executionId === executionId);
      const expectedStart = config.continuation?.head ?? authorization.baseCommit;
      if (existing) {
        if (!isDeepStrictEqual(existing.authorization, authorization) || record.executionAuthorizations?.at(-1)?.executionId !== executionId) fail("Execution交接请求载荷冲突或已被新版接管。");
        if (existing.previousExecutionId !== config.continuation?.executionId || existing.startCommit !== expectedStart) fail("原交接来源已冻结，不能更换前驱或HEAD。");
        if (record.leases.length || record.cleanedAt || record.cleanupRequestedAt) fail("原交接尚有writer或清理，不能派发新worker。");
        const repo = await this.repository(record), current = await repo.inspect();
        if (current.conflicts.length) fail("交接重试期间现场变化，拒绝派发。");
        // 交接后writer可在受管worktree内提交（封存会包含这些历史），只拒绝回退或分叉的HEAD。
        if (current.head !== expectedStart && !(await repo.containsCommit(current.head, expectedStart))) fail("交接重试期间现场变化，拒绝派发。");
        return;
      }
      if (config.continuation) {
        if (record.authorization.authorizationId === authorization.authorizationId || record.executionAuthorizations?.some(item => item.authorization.authorizationId === authorization.authorizationId)) fail("续作必须取得独立新授权，不能复用旧批准。");
        if (record.leases.length || record.cleanedAt || record.cleanupRequestedAt) fail("续作writer未交接或checkout已清理，拒绝新授权。");
        if (record.commonDirectory !== main.commonDirectory || record.authorization.repository !== authorization.repository || record.authorization.baseCommit !== authorization.baseCommit) fail("续作仓库或原Git基准不匹配。");
        const latest = record.executionAuthorizations?.at(-1);
        if (!latest || latest.executionId !== config.continuation.executionId) fail("续作来源不是原Execution最新交接。");
        const state = await (await this.repository(record)).inspect();
        if (state.head !== config.continuation.head || state.conflicts.length) fail("续作现场变化，拒绝交接；不回滚。");
        await this.write(config.workspaceId, { ...record, executionAuthorizations: [...(record.executionAuthorizations ?? []), { executionId, authorization, startCommit: state.head, previousExecutionId: config.continuation.executionId }] });
        return;
      }
      if (!isDeepStrictEqual(record.authorization, authorization) || record.executionAuthorizations?.length) fail("已有成果工作区必须明确续作来源与HEAD，不能隐式复用旧授权。");
      if (record.leases.length || record.cleanedAt || record.cleanupRequestedAt) fail("新工作区尚未安全交接。");
      const state = await (await this.repository(record)).inspect();
      if (state.head !== authorization.baseCommit || state.changedPaths.length || state.conflicts.length) fail("新工作区在交接前已变化。");
      await this.write(config.workspaceId, { ...record, executionAuthorizations: [{ executionId, authorization, startCommit: authorization.baseCommit }] });
    });
  }

  /** 某Execution的原冻结授权；不以最新授权覆盖历史Run，缺登记沿用创建授权。 */
  authorizationFor(record: ManagedWorkspace, executionId: string): WorkspaceAuthorization {
    return record.executionAuthorizations?.find(item => item.executionId === executionId)?.authorization ?? record.authorization;
  }

  /**
   * 用户显式 resume 前的现场核验与旧 writer 收尾。
   *
   * Wave Flow 新增设计（2026-10-22）：跨 attempt 交接前必须终止并核验上一个
   * executionAttempt 的全部 writer，不能"记录后放行"。任何一条无法核验即拒绝
   * 恢复；共享 worktree 中已存在的改动保留，不回滚。
   */
  prepareResume(rawConfig: ExecutionWorkspaceConfig, executionId: string): Promise<void> {
    return this.exclusive(async () => {
      assertUuid(executionId);
      const config = validateExecutionWorkspaces(rawConfig), main = await GitRepository.open(config.authorization.repository);
      const record = await this.require(config.workspaceId);
      if (record.executionAuthorizations?.length && record.executionAuthorizations.at(-1)!.executionId !== executionId) fail("工作区已交接较新Execution，旧版恢复只读。");
      if (!isDeepStrictEqual(this.authorizationFor(record, executionId), config.authorization) || record.commonDirectory !== main.commonDirectory) fail("原版恢复工作区授权或仓库身份漂移，请修订方案。");
      if (record.cleanupRequestedAt || record.cleanedAt) fail("原版恢复工作区已经清理或正在清理，不能重新派发writer。");
      const repo = await this.repository(record), state = await repo.inspect();
      if (state.conflicts.length) fail("原版恢复现场存在未解决冲突；请在受管worktree处理后再 resume。");
      const stale = record.leases.filter(lease => lease.runId === executionId);
      if (!stale.length) return;
      // 先逐条终止并核验，全部通过后才写记录；中途失败保留原租约与现场。
      const at = new Date().toISOString(), closed: ClosedWorkspaceRelease[] = [];
      for (const lease of stale) closed.push(await this.closeStaleWriter(lease, at));
      await this.write(config.workspaceId, { ...record, leases: record.leases.filter(lease => lease.runId !== executionId), closedReleases: [...(record.closedReleases ?? []), ...closed] });
    });
  }

  /**
   * 单条旧租约的终止与核验。
   *
   * 判定顺序：无进程证据 → 拒绝；进程组不存在 → 已退出；启动指纹不同 → PID
   * 复用、原 writer 已退出且不得误杀；指纹一致或 leader 已退出但组仍存在 →
   * SIGKILL 整组并轮询到消失。任何一步不可读都抛出，不当成已退出。
   */
  private async closeStaleWriter(lease: WorkspaceLease, at: string): Promise<ClosedWorkspaceRelease> {
    const base = { at, leaseId: lease.leaseId, nodeId: lease.nodeId, attempt: lease.attempt };
    if (!lease.writerIdentity) return { ...base, outcome: "not-started", reason: "writer 从未启动，无需核验进程退出。" };
    const pgid = lease.writerPgid ?? null, startedAt = lease.writerStartedAt ?? null;
    if (pgid === null || startedAt === null) fail(`节点 ${lease.nodeId} 的旧 writer 缺少进程证据，无法核验退出；拒绝恢复。`);
    if (pgid === process.pid || pgid === process.ppid) fail("旧 writer 进程组与本 Engine 重叠；拒绝终止，避免误杀。");
    const probe = await this.#control.probe(pgid);
    if (probe.state === "unknown") fail(`节点 ${lease.nodeId} 的旧 writer 进程组无法核验：${probe.reason}；拒绝恢复。`);
    if (probe.state === "absent") return { ...base, outcome: "exited", reason: "进程组已不存在，原 writer 已退出。" };
    if (probe.startedAt !== null && probe.startedAt !== startedAt) return { ...base, outcome: "exited", reason: "进程组号已被其他进程复用，原 writer 已退出。" };
    await this.#control.killGroup(pgid);
    await this.awaitWriterGroupGone(pgid, lease.nodeId);
    return { ...base, outcome: "killed", reason: "已 SIGKILL 整个进程组并确认消失。" };
  }

  /**
   * SIGKILL 后在有界预算内轮询到进程组消失。
   *
   * 终止瞬间 leader 可能进入 zombie（`kill` 仍成功但读不到启动指纹），因此
   * 预算内的 unknown/存在都视为"尚未消失"继续等待；到预算上限仍未消失或仍不可
   * 核验才拒绝恢复。进入本方法前的首次探测仍是严格模式。
   */
  private async awaitWriterGroupGone(pgid: number, nodeId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    let last = "进程组仍存在";
    for (;;) {
      if (Date.now() >= deadline) fail(`节点 ${nodeId} 的旧 writer 进程组未在预算内确认消失（${last}）；保留锁与现场，拒绝恢复。`);
      const probe = await this.#control.probe(pgid);
      if (probe.state === "absent") return;
      last = probe.state === "unknown" ? probe.reason : "进程组仍存在";
      await Bun.sleep(20);
    }
  }

  /** 只读交付记录；不存在返回null，不在查询中执行Git写入。 */
  async inspectSource(executionId: string): Promise<WorkspaceSource | null> {
    assertUuid(executionId);
    try {
      const path = join(this.root, "records", `${executionId}.source`), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("交付记录不是私有常规文件。");
      const result = JSON.parse(await readFile(path, "utf8")) as WorkspaceSource;
      if (result.executionId !== executionId || result.requestId !== executionId || result.branch !== `codex/wf-${result.workspaceId}`) fail("交付记录身份损坏。");
      assertUuid(result.workspaceId); assertUuid(result.authorizationId);
      if (![result.commit, result.baseCommit].every(oid => typeof oid === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) || !Array.isArray(result.paths) || result.paths.some(path => typeof path !== "string") || !Number.isFinite(Date.parse(result.savedAt)) || !appliedShape(result.applied)) fail("交付记录字段损坏。");
      return result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  /** 收尾失败的独立耐久诊断；retryable缺省false表示确定性拒绝，true允许下次启动幂等补收尾，不重跑业务。 */
  async recordSourceDiagnostic(executionId: string, diagnostic: string, retryable = false): Promise<void> {
    assertUuid(executionId);
    await this.write(executionId, { diagnostic, retryable }, "source-error");
  }

  /** 是否允许重启补交付；已有成功交付且已应用时不再重做。 */
  async canRetrySource(executionId: string): Promise<boolean> {
    const source = await this.inspectSource(executionId);
    if (!source) {
      await this.inspectSourceDiagnostic(executionId);
      try {
        const value = JSON.parse(await readFile(join(this.root, "records", `${executionId}.source-error`), "utf8"));
        if (value.retryable !== undefined && typeof value.retryable !== "boolean") fail("交付重试标记损坏。");
        return value.retryable !== false;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    }
    return "skippedAt" in source.applied;
  }

  private async clearSourceDiagnostic(executionId: string): Promise<void> {
    try { await unlink(join(this.root, "records", `${executionId}.source-error`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const directory = await open(join(this.root, "records"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  /** 读取既有失败原因；缺失返回null，不触发交付。 */
  async inspectSourceDiagnostic(executionId: string): Promise<string | null> {
    assertUuid(executionId);
    try {
      const path = join(this.root, "records", `${executionId}.source-error`), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("交付诊断文件不安全。");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (typeof value.diagnostic !== "string") fail("交付诊断损坏。");
      return value.diagnostic;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  /**
   * 最终封存：把共享worktree封存为一个受管commit，并自动把结果写入主工作区（保持未提交）。
   * 调用者必须先确认Execution已completed；未应用只记录原因，不回滚、不重跑业务。
   */
  finalizeSource(executionId: string, rawConfig: ExecutionWorkspaceConfig, actualNodeIds?: readonly string[]): Promise<WorkspaceSource> {
    return this.exclusive(async () => {
      assertUuid(executionId); const config = validateExecutionWorkspaces(rawConfig);
      if (actualNodeIds?.some(id => !config.authorization.nodes.some(node => node.nodeId === id))) fail("实际写节点未授权，不能最终交付。");
      const main = await GitRepository.open(config.authorization.repository);
      const workspace = await this.require(config.workspaceId);
      if (!isDeepStrictEqual(this.authorizationFor(workspace, executionId), config.authorization) || workspace.commonDirectory !== main.commonDirectory) fail("交付工作区授权/仓库身份漂移。");
      const previous = await this.inspectSource(executionId);
      if (previous) {
        if (previous.workspaceId !== config.workspaceId || previous.authorizationId !== config.authorization.authorizationId || previous.baseCommit !== config.authorization.baseCommit || previous.branch !== workspace.branch) fail("耐久交付记录与Git证据冲突。");
        if (!("skippedAt" in previous.applied)) return previous;
        // 较新的接续执行已把不同现场写入主工作区时，旧执行的补应用会把新改动回退；
        // 只允许补应用仍是当前已应用现场的那份封存，其他情况保持未应用原因。
        const latest = workspace.lastApplied;
        if (latest && latest.commit !== previous.commit) return previous;
        // 上次未自动应用：仅在主工作区重新满足条件时补应用；仍不满足则保留原因。
        const retried = await this.apply(main, workspace, executionId, previous.commit, previous.baseCommit);
        if (!retried.ok) return previous;
        await this.markApplied(workspace, executionId, previous.commit);
        const updated = { ...previous, applied: retried.state };
        await this.write(executionId, updated, "source");
        await this.clearSourceDiagnostic(executionId);
        return updated;
      }
      if (workspace.leases.length) fail("writer锁仍在，不能最终封存。");
      if (workspace.cleanedAt) fail("受管worktree已清理且没有该Execution的交付记录。");
      const handover = workspace.executionAuthorizations?.find(item => item.executionId === executionId);
      const request: GitSealRequest = { requestId: executionId, baseCommit: config.authorization.baseCommit, startCommit: handover?.startCommit ?? config.authorization.baseCommit };
      const sealed = await (await this.repository(workspace)).seal(request);
      const paths = await main.changedBetween(config.authorization.baseCommit, sealed.commit);
      const applied = await this.apply(main, workspace, executionId, sealed.commit, config.authorization.baseCommit);
      if (applied.ok) await this.markApplied(workspace, executionId, sealed.commit);
      const result: WorkspaceSource = {
        executionId, requestId: executionId, workspaceId: workspace.workspaceId, authorizationId: config.authorization.authorizationId,
        baseCommit: config.authorization.baseCommit, commit: sealed.commit, branch: workspace.branch,
        paths, applied: applied.ok ? applied.state : { skippedAt: new Date().toISOString(), reason: applied.reason }, savedAt: new Date().toISOString(),
      };
      try { await this.write(executionId, result, "source"); await this.clearSourceDiagnostic(executionId); }
      catch (error) { throw new SourcePersistenceError(`Git封存已创建，但证据关联未能耐久；可重试宿主收尾：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      return result;
    });
  }

  /** 尝试自动应用；契约条件不满足时返回原因并保留未应用，绝不覆盖用户现场。 */
  private async apply(main: GitRepository, workspace: ManagedWorkspace, executionId: string, commit: string, baseCommit: string): Promise<{ readonly ok: true; readonly state: { readonly at: string; readonly paths: readonly string[] } } | { readonly ok: false; readonly reason: string }> {
    // 同一Execution崩溃重试优先使用登记的应用意图：它记录了应用前的期望现场；续作则以上次应用结果为准。
    const intentMatches = workspace.applyIntent?.executionId === executionId && workspace.applyIntent.commit === commit;
    const expectedWorktree = intentMatches ? workspace.applyIntent!.expectedWorktree : workspace.lastApplied?.commit;
    const pending: ManagedWorkspace = { ...workspace, applyIntent: { executionId, commit, ...(expectedWorktree ? { expectedWorktree } : {}), at: new Date().toISOString() } };
    // 先耐久应用意图，再改用户现场：崩溃或部分写入后可识别为宿主动作，而不是把残留误判成用户改动。
    await this.write(workspace.workspaceId, pending);
    try {
      return { ok: true, state: { at: new Date().toISOString(), paths: await main.applyCommit(commit, baseCommit, expectedWorktree) } };
    }
    catch (error) {
      // Git命令故障、证据读取超限与真实IO错误必须抛出；应用意图保留，提示现场可能已部分写入。
      if (error instanceof GitCommandError || error instanceof GitEvidenceLimitError || !(error instanceof WorkflowContractError)) throw error;
      // 契约拒绝（dirty/HEAD漂移/ignored冲突）在任何写入前发生：清除意图并记录用户可读原因。
      await this.write(workspace.workspaceId, { ...workspace, applyIntent: undefined });
      const reason = intentMatches ? `上次自动应用未完成或现场已被改动，请人工检查主工作区后重试：${error.message}` : error.message;
      return { ok: false, reason };
    }
  }

  /** 记录最近一次成功写入主工作区的封存commit；同时清除应用意图。 */
  private async markApplied(workspace: ManagedWorkspace, executionId: string, commit: string): Promise<void> {
    await this.write(workspace.workspaceId, { ...workspace, lastApplied: { executionId, commit, at: new Date().toISOString() }, applyIntent: undefined });
  }

  /** 显式安全清理checkout；不删除分支/commit，不清理未封存或未知现场。 */
  cleanup(workspaceId: string, executionId: string, authorized: boolean): Promise<ManagedWorkspace> {
    return this.exclusive(async () => {
      if (!authorized) fail("清理worktree必须由用户明确授权。");
      assertUuid(executionId);
      const record = await this.require(workspaceId); if (record.cleanedAt) return record;
      if (record.leases.length) fail("writer/Git锁仍在，拒绝清理。");
      const source = await this.inspectSource(executionId);
      if (!source || source.workspaceId !== workspaceId) fail("该Execution尚无最终封存记录，拒绝清理。");
      const main = await GitRepository.open(record.authorization.repository);
      // 清理意图已耐久、checkout已移除但cleanedAt未落盘（崩溃恢复）：只补关联，不重复删除或猜现场。
      if (record.cleanupRequestedAt && !await pathExists(record.cwd)) {
        await main.verifyCommitExists(source.commit);
        const cleaned = { ...record, cleanedAt: new Date().toISOString() };
        await this.write(workspaceId, cleaned); return cleaned;
      }
      const repo = await this.repository(record), state = await repo.inspect();
      if (state.head !== source.commit) fail("封存后worktree HEAD已变化，拒绝清理。");
      if (state.changedPaths.length || state.conflicts.length) fail("worktree仍有未提交内容或冲突，拒绝清理。");
      const requested = record.cleanupRequestedAt ? record : { ...record, cleanupRequestedAt: new Date().toISOString() };
      if (!record.cleanupRequestedAt) { await this.write(workspaceId, requested); }
      try { await lstat(record.cwd); await main.removeWorktree(record.cwd); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await main.verifyCommitExists(source.commit);      }
      const cleaned = { ...requested, cleanedAt: new Date().toISOString() }; await this.write(workspaceId, cleaned); return cleaned;
    });
  }

  /** 为一个writer session创建私有scratch；退出后由执行器清理，不承载成果或授权。 */
  async createScratch(leaseId: string): Promise<string> {
    assertUuid(leaseId); const path = join(this.root, "scratch", leaseId);
    await mkdir(path, { mode: 0o700 });
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) fail("writer scratch不安全。");
    return realpath(path);
  }

  private async repository(record: ManagedWorkspace): Promise<GitRepository> {
    if (record.cleanedAt) fail("受管worktree已清理，仅保留Git成果对象。");
    const repo = await GitRepository.open(record.cwd), state = await repo.inspect();
    if (state.commonDirectory !== record.commonDirectory || state.gitDirectory !== record.gitDirectory || state.branch !== `refs/heads/${record.branch}`) fail("受管工作区Git身份漂移。");
    return repo;
  }
  private async requireLease(lease: WorkspaceLease): Promise<ManagedWorkspace> {
    const record = await this.require(lease.workspaceId);
    if (!record.leases.some(item => item.leaseId === lease.leaseId && isDeepStrictEqual(item, lease))) fail("租约过期或身份不匹配。");
    return record;
  }
  private async require(id: string): Promise<ManagedWorkspace> { const record = await this.read(id, false); if (!record) fail("受管工作区不存在。"); return record; }
  private async read(id: string, missing: boolean): Promise<ManagedWorkspace | null> {
    assertUuid(id); const path = join(this.root, "records", `${id}.json`);
    try {
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("Workspace记录不是私有常规文件。");
      const record = JSON.parse(await readFile(path, "utf8")) as ManagedWorkspace;
      validateAuthorization(record.authorization);
      if (record.workspaceId !== id || record.cwd !== join(this.root, "trees", id) || record.branch !== `codex/wf-${id}` || !record.gitDirectory?.startsWith(record.commonDirectory + "/worktrees/") || !Array.isArray(record.leases) || (record.cleanedAt !== null && typeof record.cleanedAt !== "string")) fail("Workspace记录身份损坏。");
      for (const lease of record.leases) {
        validateIdentity(lease);
        if (lease.workspaceId !== id || typeof lease.leaseId !== "string" || !/^[0-9a-f-]{36}$/.test(lease.leaseId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(lease.startCommit) || (lease.writerIdentity !== null && (typeof lease.writerIdentity !== "string" || !lease.writerIdentity.trim()))) fail("Workspace租约记录损坏。");
        // writer 进程证据可缺省（旧记录/未启动），一旦存在必须是可核验形态；损坏即拒绝恢复。
        if (lease.writerPgid !== undefined && lease.writerPgid !== null && (!Number.isSafeInteger(lease.writerPgid) || lease.writerPgid <= 1)) fail("Workspace租约进程组记录损坏。");
        if (lease.writerStartedAt !== undefined && lease.writerStartedAt !== null && (typeof lease.writerStartedAt !== "string" || !lease.writerStartedAt.trim())) fail("Workspace租约启动时间记录损坏。");
      }
      if (record.closedReleases !== undefined) {
        if (!Array.isArray(record.closedReleases)) fail("Workspace恢复终止记录损坏。");
        for (const entry of record.closedReleases) {
          if (!entry || typeof entry !== "object" || !Number.isFinite(Date.parse(entry.at)) || typeof entry.leaseId !== "string" || !/^[0-9a-f-]{36}$/.test(entry.leaseId) || typeof entry.nodeId !== "string" || !entry.nodeId.trim() || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || !["killed", "exited", "not-started"].includes(entry.outcome) || typeof entry.reason !== "string" || !entry.reason.trim()) fail("Workspace恢复终止记录损坏。");
        }
      }
      if (new Set(record.leases.map(lease => lease.leaseId)).size !== record.leases.length) fail("Workspace租约重复。");
      if (record.lastApplied !== undefined) {
        if (!record.lastApplied || typeof record.lastApplied !== "object") fail("Workspace应用记录损坏。");
        assertUuid(record.lastApplied.executionId);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.lastApplied.commit) || !Number.isFinite(Date.parse(record.lastApplied.at))) fail("Workspace应用记录损坏。");
      }
      if (record.applyIntent !== undefined) {
        const intent = record.applyIntent;
        if (!intent || typeof intent !== "object") fail("Workspace应用意图损坏。");
        assertUuid(intent.executionId);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(intent.commit) || !Number.isFinite(Date.parse(intent.at))
          || (intent.expectedWorktree !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(intent.expectedWorktree))) fail("Workspace应用意图损坏。");
      }
      if (record.executionAuthorizations !== undefined) {
        if (!Array.isArray(record.executionAuthorizations)) fail("Execution授权历史损坏。");
        const ids = new Set<string>();
        for (const entry of record.executionAuthorizations) {
          assertUuid(entry.executionId); if (entry.previousExecutionId !== undefined) assertUuid(entry.previousExecutionId);
          validateAuthorization(entry.authorization);
          if (ids.has(entry.executionId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.startCommit) || entry.authorization.repository !== record.authorization.repository || entry.authorization.baseCommit !== record.authorization.baseCommit) fail("Execution授权身份损坏。");
          ids.add(entry.executionId);
        }
      }
      return record;
    }
    catch (error) { if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async write(id: string, value: ManagedWorkspace | WorkspaceSource | { diagnostic: string; retryable: boolean }, suffix = "json"): Promise<void> {
    const directory = join(this.root, "records"), file = join(directory, `${id}.${suffix}`), temp = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file); const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const pending = (WorkspaceManager.mutationTails.get(this.root) ?? Promise.resolve()).then(operation); WorkspaceManager.mutationTails.set(this.root, pending.then(() => undefined, () => undefined)); return pending; }
}

/** 目录是否存在；仅用于清理崩溃恢复，其他错误如实抛出。 */
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function appliedShape(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const applied = value as Record<string, unknown>;
  if (typeof applied.at === "string" && Number.isFinite(Date.parse(applied.at)) && Array.isArray(applied.paths) && applied.paths.every(path => typeof path === "string")) return true;
  return typeof applied.skippedAt === "string" && Number.isFinite(Date.parse(applied.skippedAt)) && typeof applied.reason === "string" && applied.reason.length > 0;
}
function assertUuid(id: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail("Workspace身份必须为UUID。"); }
function validateIdentity(identity: WorkspaceNodeIdentity): void { assertUuid(identity.runId); if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(identity.nodeId) || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1) fail("成果节点身份无效。"); }
function validateAuthorization(value: WorkspaceAuthorization): void {
  assertUuid(value.authorizationId);
  if (!Number.isFinite(Date.parse(value.approvedAt)) || !value.repository.startsWith("/") || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.baseCommit) || typeof value.excludeExistingDirty !== "boolean" || !Array.isArray(value.nodes) || !value.nodes.length || new Set(value.nodes.map(node => node.nodeId)).size !== value.nodes.length) fail("Workspace授权字段无效。");
  for (const node of value.nodes) { if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(node.nodeId) || "paths" in node || "externalResources" in node) fail("Workspace节点授权无效。"); }
}
function fail(message: string): never { throw new WorkflowContractError(message); }
