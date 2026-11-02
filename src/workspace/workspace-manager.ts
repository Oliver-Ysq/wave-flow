import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GitRepository } from "./git-repository";
import type { ExecutionWorkspaceConfig } from "./execution-workspaces";
import { isWorkspaceWriterAuthorized, validateExecutionWorkspaces } from "./execution-workspaces";
import { WorkflowContractError } from "../workflow/errors";

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
  /** 循环/批量写节点的稳定字面量前缀；用户在确认时逐前缀披露，实际节点在 Run Journal 证据中记录。 */
  readonly dynamicNodes?: readonly { /** 实际节点 id 的字面量前缀，非空。 */ readonly nodeIdPrefix: string }[];
};

/** 工作区成果事实；只记录 Git 与授权，不复制业务 complete 状态。 */
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
  /** checkout已安全移除时间；受管分支引用仍保留，磁盘内容已删除。 */
  readonly cleanedAt: string | null;
  /** 清理前耐久意图；checkout移除后关联失败时按原身份补写，不再删除未知目录。 */
  readonly cleanupRequestedAt: string | null;
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
      const record: ManagedWorkspace = { workspaceId, cwd, branch, commonDirectory: repo.commonDirectory, gitDirectory: "", authorization, cleanedAt: null, cleanupRequestedAt: null };
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
   * 写节点启动前的现场门禁：授权、清理状态、冲突与交接 HEAD。
   *
   * 写者进程证据由 Run Journal 的 `agent.session.writer` / `agent.writer` /
   * `agent.writerIntent` 记录，恢复前围栏由 Engine 统一执行。
   */
  assertWriterAllowed(
    /** 受管工作区 UUID。 */ workspaceId: string,
    /** 当前 Execution/Run 身份；必须是最近一次交接的 Execution。 */ executionId: string,
    /** 实际要启动的写节点 id；循环节点须匹配已披露前缀。 */ nodeId: string,
  ): Promise<void> {
    return this.exclusive(async () => {
      assertUuid(executionId);
      if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(nodeId)) fail("成果节点身份无效。");
      const record = await this.require(workspaceId);
      if (record.executionAuthorizations?.length && record.executionAuthorizations.at(-1)!.executionId !== executionId) fail("工作区已交接较新Execution，旧执行不能重新取得writer。");
      if (record.cleanedAt) fail("受管worktree已清理；保留成果分支但不能启动新writer。");
      if (record.cleanupRequestedAt) fail("受管worktree已有耐久清理意图，禁止新writer；请先完成原清理核查。");
      if (!isWorkspaceWriterAuthorized(this.authorizationFor(record, executionId), nodeId)) fail("节点未获成果提交授权。");
      const repo = await this.repository(record), state = await repo.inspect();
      if (state.conflicts.length) fail("工作区存在未解决冲突，禁止启动writer；请先处理现场。");
      const handover = record.executionAuthorizations?.find(item => item.executionId === executionId);
      if (handover && state.head !== handover.startCommit && !(await repo.containsCommit(state.head, handover.startCommit))) fail("已交接现场HEAD被外部修改，拒绝启动writer，不自动回滚。");
    });
  }

  /** 读取 Git 成果与写者证据，调用者不能据此覆盖业务状态。 */
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
        if (record.cleanedAt || record.cleanupRequestedAt) fail("原交接正在清理，不能派发新 worker。");
        const repo = await this.repository(record), current = await repo.inspect();
        if (current.conflicts.length) fail("交接重试期间现场变化，拒绝派发。");
        // 交接后 writer 可在受管 worktree 内提交；只拒绝回退或分叉的 HEAD。
        if (current.head !== expectedStart && !(await repo.containsCommit(current.head, expectedStart))) fail("交接重试期间现场变化，拒绝派发。");
        return;
      }
      if (config.continuation) {
        if (record.authorization.authorizationId === authorization.authorizationId || record.executionAuthorizations?.some(item => item.authorization.authorizationId === authorization.authorizationId)) fail("续作必须取得独立新授权，不能复用旧批准。");
        if (record.cleanedAt || record.cleanupRequestedAt) fail("原checkout已清理或正在清理，拒绝新授权。");
        if (record.commonDirectory !== main.commonDirectory || record.authorization.repository !== authorization.repository || record.authorization.baseCommit !== authorization.baseCommit) fail("续作仓库或原Git基准不匹配。");
        const latest = record.executionAuthorizations?.at(-1);
        if (!latest || latest.executionId !== config.continuation.executionId) fail("续作来源不是原Execution最新交接。");
        const state = await (await this.repository(record)).inspect();
        if (state.head !== config.continuation.head || state.conflicts.length) fail("续作现场变化，拒绝交接；不回滚。");
        await this.write(config.workspaceId, { ...record, executionAuthorizations: [...(record.executionAuthorizations ?? []), { executionId, authorization, startCommit: state.head, previousExecutionId: config.continuation.executionId }] });
        return;
      }
      if (!isDeepStrictEqual(record.authorization, authorization) || record.executionAuthorizations?.length) fail("已有成果工作区必须明确续作来源与HEAD，不能隐式复用旧授权。");
      if (record.cleanedAt || record.cleanupRequestedAt) fail("新工作区尚未安全交接。");
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
   * 用户显式 resume 前的现场核验。
   *
   * 写者终止与围栏已上移到 Engine（Journal 写者证据 + 进程组核验）；这里只校验
   * WorkspaceManager 自己能证明的事实：授权、仓库身份、清理状态、HEAD 与冲突。
   * 任何一项漂移即拒绝恢复；共享 worktree 中已存在的改动保留，不回滚。
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
      // writer 终止与核验已上移到 Engine：恢复入口先按 Journal 写者证据围栏，
      // WorkspaceManager 只保留授权、仓库身份、HEAD 与冲突校验。
    });
  }

  /**
   * 显式清理受管checkout。宿主不再保存任何成果快照：未提交改动随目录删除，由用户负责。
   *
   * 清理前必须由 Engine 提供写者围栏证明（Journal 写者证据 + 进程组核验）；没有证明
   * 一律拒绝。仍拒绝 Git身份/注册漂移、冲突、Git锁、嵌套注册worktree或已初始化submodule。
   * ignored内容允许随checkout删除。
   */
  cleanup(
    /** 受管工作区 UUID。 */ workspaceId: string,
    /** 用户是否已明确授权删除该 checkout；false 一律拒绝。 */ authorized: boolean,
    /** 发起清理的 Execution；必须是该 workspace 最近一次交接的 Execution。 */ executionId: string,
    /** Engine 提供的写者围栏证明；必须完成 Journal 证据 + 进程组核验，失败即抛错并保留现场。 */ assertNoWriters: () => Promise<void>,
  ): Promise<ManagedWorkspace> {
    return this.exclusive(async () => {
      if (!authorized) fail("清理worktree必须由用户明确授权。");
      if (typeof assertNoWriters !== "function") fail("清理必须提供 Engine 的写者围栏证明。");
      assertUuid(executionId);
      const record = await this.require(workspaceId); if (record.cleanedAt) return record;
      // worktree 跨 Execution 共享：只有最近一次交接的 Execution 能清理它，否则可能删掉
      // 正在写入的较新执行现场。旧执行只能查看历史。
      const latest = record.executionAuthorizations?.at(-1);
      if (latest && latest.executionId !== executionId) fail("工作区已交接给较新Execution，旧执行不能清理该worktree。");
      await assertNoWriters();
      const main = await GitRepository.open(record.authorization.repository);
      // 清理意图已耐久、checkout已移除但cleanedAt未落盘（崩溃恢复）：只补关联，不重复删除或猜现场。
      if (record.cleanupRequestedAt && !await pathExists(record.cwd)) {
        const cleaned = { ...record, cleanedAt: new Date().toISOString() };
        await this.write(workspaceId, cleaned); return cleaned;
      }
      const requested = record.cleanupRequestedAt ? record : { ...record, cleanupRequestedAt: new Date().toISOString() };
      if (!record.cleanupRequestedAt) { await this.write(workspaceId, requested); }
      let checkoutPresent = true;
      try { await lstat(record.cwd); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        checkoutPresent = false;
      }
      // 仅初始lstat的ENOENT表示目录已不在；删除过程中的内部ENOENT必须抛出，不能误记cleanedAt。
      if (checkoutPresent) await main.removeWorktree(record.cwd, { gitDirectory: record.gitDirectory, branch: `refs/heads/${record.branch}` });
      const cleaned = { ...requested, cleanedAt: new Date().toISOString() }; await this.write(workspaceId, cleaned); return cleaned;
    });
  }

  /**
   * 为一个writer session创建私有scratch；key 由节点身份构造，退出后由执行器清理。
   *
   * 每次调用生成独立目录：同一节点同一次 attempt 的启动超时自动重试也必须拿到干净
   * scratch，不能复用上一个 writer 的技能投影或工具临时文件。
   */
  async createScratch(key: string): Promise<string> {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(key)) fail("writer scratch key 无效。");
    const path = join(this.root, "scratch", `${key}.${crypto.randomUUID()}`);
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
  private async require(id: string): Promise<ManagedWorkspace> { const record = await this.read(id, false); if (!record) fail("受管工作区不存在。"); return record; }
  private async read(id: string, missing: boolean): Promise<ManagedWorkspace | null> {
    assertUuid(id); const path = join(this.root, "records", `${id}.json`);
    try {
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("Workspace记录不是私有常规文件。");
      const record = JSON.parse(await readFile(path, "utf8")) as ManagedWorkspace;
      // 旧版记录携带本版本已不存在的写者状态字段：不支持半迁移，fail closed，
      // 由用户删除不兼容的本地记录，避免旧写者证据被静默忽略。
      const legacy = record as unknown as Record<string, unknown>;
      if ("leases" in legacy || "closedReleases" in legacy) fail("旧版工作区记录不兼容；请清理旧数据后重试。");
      validateAuthorization(record.authorization);
      if (record.workspaceId !== id || record.cwd !== join(this.root, "trees", id) || record.branch !== `codex/wf-${id}` || !record.gitDirectory?.startsWith(record.commonDirectory + "/worktrees/") || (record.cleanedAt !== null && typeof record.cleanedAt !== "string")) fail("Workspace记录身份损坏。");
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
  private async write(id: string, value: ManagedWorkspace, suffix = "json"): Promise<void> {
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
function assertUuid(id: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail("Workspace身份必须为UUID。"); }
function validateAuthorization(value: WorkspaceAuthorization): void {
  assertUuid(value.authorizationId);
  const dynamicNodes=value.dynamicNodes;
  if (!Number.isFinite(Date.parse(value.approvedAt)) || !value.repository.startsWith("/") || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.baseCommit) || typeof value.excludeExistingDirty !== "boolean" || !Array.isArray(value.nodes) || (!value.nodes.length && !(Array.isArray(dynamicNodes) && dynamicNodes.length)) || new Set(value.nodes.map(node => node.nodeId)).size !== value.nodes.length) fail("Workspace授权字段无效。");
  for (const node of value.nodes) { if (!/^[A-Za-z0-9._:/-]{1,120}$/.test(node.nodeId) || "paths" in node || "externalResources" in node) fail("Workspace节点授权无效。"); }
  if (dynamicNodes !== undefined) {
    if (!Array.isArray(dynamicNodes)) fail("Workspace动态写节点授权必须为数组。");
    const prefixes = new Set<string>();
    for (const node of dynamicNodes) { if (!node || typeof node.nodeIdPrefix !== "string" || !/^[A-Za-z0-9._:/-]{1,120}$/.test(node.nodeIdPrefix) || prefixes.has(node.nodeIdPrefix) || "paths" in node || "externalResources" in node) fail("Workspace动态写节点授权无效。"); prefixes.add(node.nodeIdPrefix); }
  }
}
function fail(message: string): never { throw new WorkflowContractError(message); }
