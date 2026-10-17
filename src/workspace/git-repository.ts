import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowContractError } from "../workflow/errors";

/** Git子进程执行失败；区别于授权/现场契约拒绝，允许有界幂等收尾重试。 */
export class GitCommandError extends WorkflowContractError {}

/** Git 可见现场；不是外部副作用快照，不读取 ignored 文件正文。 */
export type GitWorkspaceState = {
  /** canonical worktree 根目录，身份变化时拒绝使用。 */
  readonly cwd: string;
  /** canonical 共享 Git 元数据目录，用于区分不同仓库。 */
  readonly commonDirectory: string;
  /** 当前worktree专属Git元数据目录；允许集成写index/MERGE_HEAD，不开放共享refs。 */
  readonly gitDirectory: string;
  /** 工作区 HEAD 的完整 commit oid。 */
  readonly head: string;
  /** 当前分支全名；detached HEAD 为 null。 */
  readonly branch: string | null;
  /** 相对 HEAD 的 tracked/untracked 改动路径，重命名按删除与新增处理。 */
  readonly changedPaths: readonly string[];
  /** 尚未解决的冲突路径；非空时不能交付。 */
  readonly conflicts: readonly string[];
  /** Git忽略的现场文件；不纳入commit，但阻止自动清理，避免删除未知依赖/凭据。 */
  readonly ignoredPaths: readonly string[];
};

/** 用户明确授权的受管成果保存请求；只授权指定工作区与文件，不授权 push/远程。 */
export type GitSaveRequest = {
  /** 独立保存请求 UUID，写入 commit trailer，关联失败后用于核验既有成果。 */
  readonly requestId: string;
  /** 原始 workspace 绑定的基准完整 oid；不得由模型预测。 */
  readonly baseCommit: string;
  /** 本次 writer 启动前 HEAD，commit 只能以该节点现场为父。 */
  readonly startCommit: string;
  /** 精确的仓库相对文件路径白名单；未知文件使保存失败，不使用 git add 全目录。 */
  readonly allowedPaths: readonly string[];
  /** 集成成果的额外父提交；均由Engine核验，普通writer为空。 */
  readonly mergeParents?: readonly string[];
  /** 受管writer私有对象库；宿主在更新ref前导入可达对象，必须位于私有scratch。 */
  readonly alternateObjectDirectory?: string;
};

/** 保存的标准 Git 证据；无改动不创建空 commit。 */
export type GitSavedResult = {
  /** 保存请求身份，用于关联去重。 */
  readonly requestId: string;
  /** 成果 commit；无改动时等于 startCommit。 */
  readonly commit: string;
  /** 本次实际提交路径，不能超出用户授权。 */
  readonly paths: readonly string[];
  /** true 表示未新建 commit。 */
  readonly unchanged: boolean;
};

/** 用户明确确认的最终交付；只创建新ref，不checkout、不修改主分支或远程。 */
export type GitDeliveryRequest = {
  /** 确认请求UUID；同分支同请求异载荷拒绝。 */ readonly requestId: string;
  /** 冻结基准完整oid，也是交付commit的唯一父。 */ readonly baseCommit: string;
  /** 已核验最终ready成果的完整oid；只读取其tree。 */ readonly sourceCommit: string;
  /** 精确文件授权集合；最终相对基准的diff不能越界。 */ readonly allowedPaths: readonly string[];
  /** 仅允许codex/delivery-<Execution UUID>，不得覆盖已有异源分支。 */ readonly branch: string;
};

/** 单父交付证据；内部来源commit仍保留，不代表主分支已合入。 */
export type GitDeliveryResult = {
  /** 原确认请求UUID。 */ readonly requestId: string;
  /** 新交付分支短名。 */ readonly branch: string;
  /** 单父交付commit完整oid。 */ readonly commit: string;
  /** 被整理的最终内部成果完整oid。 */ readonly sourceCommit: string;
  /** 相对冻结基准实际变化文件。 */ readonly paths: readonly string[];
};

/** 固定 Git argv、禁 hooks/外部 diff/filter 的受管 Git 底座；不负责 writer 生命周期。 */
export class GitRepository {
  private constructor(readonly cwd: string, readonly commonDirectory: string) {}

  /** 只读打开仓库根目录，拒绝软链接入口、非根目录及不安全仓库特性。 */
  static async open(path: string): Promise<GitRepository> {
    if (!isAbsolute(path) || (await lstat(path)).isSymbolicLink()) fail("Git 工作区必须为非软链接绝对目录。");
    const cwd = await realpath(path);
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(root) !== cwd) fail("Git 工作区必须绑定仓库根目录。");
    const commonDirectory = await realpath(resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()));
    const repo = new GitRepository(cwd, commonDirectory);
    await repo.assertSafe();
    await repo.commitOid("HEAD");
    return repo;
  }

  /** 读取当前 Git 可见证据；关闭外部 diff/textconv，不将无改动解释为没有外部影响。 */
  async inspect(): Promise<GitWorkspaceState> {
    await this.assertIdentity();
    await this.assertSafe();
    const head = await this.commitOid("HEAD");
    const branch = (await git(this.cwd, ["symbolic-ref", "-q", "HEAD"], true)).trim() || null;
    const tracked = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"]));
    const untracked = splitPaths(await git(this.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const conflicts = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U", "-z", "--"]));
    const ignoredPaths=splitPaths(await git(this.cwd,["ls-files","--others","--ignored","--exclude-standard","-z"]));
    return { cwd: this.cwd, commonDirectory: this.commonDirectory, gitDirectory: await this.gitDirectory(), head, branch, changedPaths: [...new Set([...tracked, ...untracked])].sort(), conflicts,ignoredPaths };
  }

  /** 集成前重新核验真实commit与父提交范围，不能只相信Workspace JSON中的hash。 */
  async verifySavedCommit(commit: string, allowedPaths: readonly string[], startCommit?: string, expectedPaths?: readonly string[]): Promise<void> {
    assertOid(commit); allowedPaths.forEach(assertPath);
    if (await this.commitOid(commit) !== commit) fail("成果commit不可验证。");
    if (startCommit) {
      assertOid(startCommit);
      await git(this.cwd, ["merge-base", "--is-ancestor", startCommit, commit]);
      const paths = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", startCommit, commit, "--"])).sort();
      assertAllowed(paths, allowedPaths);
      if (expectedPaths && JSON.stringify(paths) !== JSON.stringify([...expectedPaths].sort())) fail("成果commit文件范围与耐久关联不一致。");
    }
    const state = await this.inspect();
    if (state.head !== commit || state.changedPaths.length || state.conflicts.length) fail("成果工作区现场漂移或未收尾，拒绝交接。");
  }

  /** 从明确已验证 commit 新建独立 worktree；不复制、暂存或提交主工作区 dirty 内容。 */
  async createWorktree(directory: string, branch: string, baseCommit: string): Promise<GitRepository> {
    await this.assertIdentity();
    await this.assertSafe();
    assertOid(baseCommit);
    if (!/^codex\/wf-[a-z0-9-]+$/.test(branch)) fail("受管分支必须使用 codex/wf- 安全命名。");
    if (await this.commitOid(baseCommit) !== baseCommit) fail("基准 commit 不可验证。");
    if (!isAbsolute(directory) || within(this.cwd, directory) || within(this.commonDirectory, directory)) fail("受管 worktree 必须位于主工作区及 Git 元数据目录之外。");
    const parent = await realpath(resolve(directory, ".."));
    if (resolve(parent, relative(resolve(directory, ".."), directory)) !== directory) fail("worktree 父目录必须为 canonical 路径。");
    await git(this.cwd, ["worktree", "add", "-b", branch, "--", directory, baseCommit]);
    return GitRepository.open(directory);
  }

  /** 用户批准后只移除已清洁worktree checkout；分支/commit保留，不自动删ref。 */
  async removeWorktree(directory: string): Promise<void> {
    await this.assertIdentity(); await this.assertSafe();
    if (!isAbsolute(directory) || within(this.cwd, directory) || within(this.commonDirectory, directory)) fail("只能清理主工作区外的受管worktree。");
    const target = await GitRepository.open(directory), state = await target.inspect();
    if (target.commonDirectory !== this.commonDirectory || state.changedPaths.length || state.conflicts.length || state.ignoredPaths.length) fail("worktree仍有未提交/ignored内容或冲突，拒绝清理。");
    await git(this.cwd, ["worktree", "remove", "--", directory]);
  }

  /** checkout已清理时从仓库对象核验成果，不要求当前HEAD等于来源commit。 */
  async verifyCommitObject(commit: string, startCommit: string, allowedPaths: readonly string[], expectedPaths: readonly string[]): Promise<void> {
    assertOid(commit); assertOid(startCommit); allowedPaths.forEach(assertPath); expectedPaths.forEach(assertPath);
    if (await this.commitOid(commit) !== commit) fail("成果commit不可验证。");
    await git(this.cwd, ["merge-base", "--is-ancestor", startCommit, commit]);
    const paths=splitPaths(await git(this.cwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",startCommit,commit,"--"])).sort();
    assertAllowed(paths,allowedPaths);if(JSON.stringify(paths)!==JSON.stringify([...expectedPaths].sort()))fail("成果commit文件范围与耐久关联不一致。");
  }

  /** 核验最终来源的Git父链覆盖每份独立成果，不凭声明推断已集成。 */
  async containsCommit(source: string, ancestor: string): Promise<boolean> {
    assertOid(source); assertOid(ancestor);
    return (await git(this.cwd, ["merge-base", ancestor, source])).trim() === ancestor;
  }

  /** 整理最终tree为基准之后一条单父commit；CAS仅创建新分支，重试复核原载荷。 */
  async deliverSquash(request: GitDeliveryRequest): Promise<GitDeliveryResult> {
    assertOid(request.baseCommit); assertOid(request.sourceCommit); request.allowedPaths.forEach(assertPath);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.requestId)
      || !/^codex\/delivery-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.branch)) fail("交付请求/分支身份必须为UUID安全命名。");
    await this.assertIdentity(); await this.assertSafe();
    await this.commitOid(request.baseCommit); await this.commitOid(request.sourceCommit);
    await git(this.cwd, ["merge-base", "--is-ancestor", request.baseCommit, request.sourceCommit]);
    const paths = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", request.baseCommit, request.sourceCommit, "--"])).sort();
    assertAllowed(paths, request.allowedPaths);
    const tree = (await git(this.cwd, ["rev-parse", `${request.sourceCommit}^{tree}`])).trim();
    const message = `Wave Flow squash delivery\n\nWave-Flow-Delivery: ${request.requestId}\nWave-Flow-Source: ${request.sourceCommit}\nWave-Flow-Paths: ${JSON.stringify([...new Set(request.allowedPaths)].sort())}`;
    const ref = `refs/heads/${request.branch}`;
    const existing = (await git(this.cwd, ["rev-parse", "--verify", "--quiet", ref], true)).trim();
    if (existing) {
      if ((await git(this.cwd, ["show", "-s", "--format=%P", existing])).trim() !== request.baseCommit
        || (await git(this.cwd, ["rev-parse", `${existing}^{tree}`])).trim() !== tree
        || (await git(this.cwd, ["show", "-s", "--format=%B", existing])).trimEnd() !== message) fail("交付分支已存在且请求/来源/授权冲突，禁止覆盖。");
      return { requestId: request.requestId, branch: request.branch, commit: existing, sourceCommit: request.sourceCommit, paths };
    }
    const commit = (await git(this.cwd, ["commit-tree", tree, "-p", request.baseCommit], false, {}, `${message}\n`)).trim();
    assertOid(commit);
    await git(this.cwd, ["update-ref", ref, commit, "0".repeat(commit.length)]);
    return { requestId: request.requestId, branch: request.branch, commit, sourceCommit: request.sourceCommit, paths };
  }

  /** writer 已退出后调用；只保存白名单文件，已有同请求 commit 时复核后返回而非重复提交。 */
  async save(request: GitSaveRequest): Promise<GitSavedResult> {
    assertRequest(request);
    if (request.alternateObjectDirectory) {
      const info = await lstat(request.alternateObjectDirectory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(request.alternateObjectDirectory) !== request.alternateObjectDirectory) fail("私有Git对象目录身份不安全。");
    }
    const state = await this.inspect();
    if (await this.gitDirectory() === this.commonDirectory || !state.branch?.startsWith("refs/heads/codex/wf-")) fail("禁止保存主工作区或非受管分支。");
    if (state.conflicts.length) fail("尚有 merge 冲突，成果不可 ready。");
    await git(this.cwd, ["merge-base", "--is-ancestor", request.baseCommit, request.startCommit]);
    if (state.head !== request.startCommit) {
      const message = await git(this.cwd, ["show", "-s", "--format=%B", state.head]);
      const parents = (await git(this.cwd, ["show", "-s", "--format=%P", state.head])).trim();
      const expectedParents = [request.startCommit, ...(request.mergeParents ?? [])].join(" ");
      if (parents !== expectedParents || message.trimEnd() !== `Wave Flow managed result\n\nWave-Flow-Save: ${request.requestId}`) fail("HEAD 已发生未授权变化，不能补存或猜测成果。");
      const paths = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", request.startCommit, state.head, "--"]));
      assertAllowed(paths, request.allowedPaths);
      // update-ref 成功后、index 刷新前进程可能中断。先比较工作区字节对应树，再恢复索引。
      await this.assertTreeMatchesHead(request.allowedPaths);
      await git(this.cwd, ["read-tree", state.head]);
      if (request.mergeParents?.length) await git(this.cwd, ["merge", "--quit"]);
      return { requestId: request.requestId, commit: state.head, paths, unchanged: false };
    }
    assertAllowed(state.changedPaths, request.allowedPaths);
    if (!state.changedPaths.length && !request.mergeParents?.length) return { requestId: request.requestId, commit: state.head, paths: [], unchanged: true };
    for (const path of state.changedPaths) await this.assertFilePath(path);
    const temp = await mkdtemp(join(await this.gitDirectory(), "wf-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index"), ...(request.alternateObjectDirectory ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: request.alternateObjectDirectory } : {}) };
      await git(this.cwd, ["read-tree", state.head], false, env);
      if (state.changedPaths.length) await git(this.cwd, ["--literal-pathspecs", "add", "--", ...state.changedPaths], false, env);
      const tree = (await git(this.cwd, ["write-tree"], false, env)).trim();
      if (request.alternateObjectDirectory) await importGitObjects(this.cwd, tree, env);
      const parents = [state.head, ...(request.mergeParents ?? [])];
      for (const parent of parents) { assertOid(parent); if (await this.commitOid(parent) !== parent) fail("集成父commit不可验证。"); }
      const commit = (await git(this.cwd, ["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent])], false, {}, `Wave Flow managed result\n\nWave-Flow-Save: ${request.requestId}\n`)).trim();
      assertOid(commit);
      // compare-and-swap 保证迟到保存不能覆盖新的 HEAD；失败保留 Git 对象，不自动重试。
      await git(this.cwd, ["update-ref", state.branch, commit, state.head]);
      await git(this.cwd, ["read-tree", commit]);
      if (request.mergeParents?.length) await git(this.cwd, ["merge", "--quit"]);
      return { requestId: request.requestId, commit, paths: state.changedPaths, unchanged: false };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  private async assertTreeMatchesHead(allowed: readonly string[]): Promise<void> {
    const temp = await mkdtemp(join(await this.gitDirectory(), "wf-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await git(this.cwd, ["read-tree", "HEAD"], false, env);
      const paths = (await this.inspect()).changedPaths;
      assertAllowed(paths, allowed);
      for (const path of paths) await this.assertFilePath(path);
      if (paths.length) await git(this.cwd, ["--literal-pathspecs", "add", "--", ...paths], false, env);
      const tree = (await git(this.cwd, ["write-tree"], false, env)).trim();
      const expected = (await git(this.cwd, ["rev-parse", "HEAD^{tree}"])).trim();
      if (tree !== expected) fail("保存 commit 后现场已改变，拒绝补关联；请显式修订。");
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  private async assertIdentity(): Promise<void> {
    if ((await lstat(this.cwd)).isSymbolicLink() || await realpath(this.cwd) !== this.cwd) fail("工作区身份已变化。");
    if (await realpath(resolve(this.cwd, (await git(this.cwd, ["rev-parse", "--git-common-dir"])).trim())) !== this.commonDirectory) fail("Git 仓库身份已变化。");
  }

  private async gitDirectory(): Promise<string> { return realpath(resolve(this.cwd, (await git(this.cwd, ["rev-parse", "--git-dir"])).trim())); }

  private async commitOid(ref: string): Promise<string> {
    const oid = (await git(this.cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    assertOid(oid);
    return oid;
  }

  private async assertSafe(): Promise<void> {
    const config = await git(this.cwd, ["config", "--local", "--get-regexp", "^(filter\\.|include\\.|includeif\\.|core\\.hookspath)"], true);
    if (config.trim()) fail("仓库配置含 hooks/filters/include；需先显式处理，禁止静默执行。");
    const entries = splitPaths(await git(this.cwd, ["ls-files", "--stage", "-z"]));
    if (entries.some(entry => /^(120000|160000) /.test(entry))) fail("首版不支持 tracked 符号链接或子模块。");
    if (entries.some(entry => /\t(?:.*\/)?\.gitattributes$/.test(entry))) fail("首版不支持仓库 Git attributes/filters。");
    // 工作区未跟踪的attributes同样影响git add；不能只检查index里的文件。
    const attributes = await git(this.cwd, ["ls-files", "--others", "--cached", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
    if (attributes) fail("首版不支持工作区 Git attributes/filters。");
    const ignoredAttributes = await git(this.cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
    if (ignoredAttributes) fail("首版不支持被忽略的Git attributes/filters。");
    for (const directory of new Set([this.commonDirectory, await this.gitDirectory()])) {
      try { if ((await lstat(join(directory, "info", "attributes"))).isFile()) fail("首版不支持Git info/attributes。"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const hooks = join(this.commonDirectory, "hooks");
    const { readdir } = await import("node:fs/promises");
    try { if ((await readdir(hooks)).some(name => !name.endsWith(".sample"))) fail("仓库存在非示例 Git hook；禁止静默运行或忽略未知钩子。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async assertFilePath(path: string): Promise<void> {
    assertPath(path);
    const segments = path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      try {
        const info = await lstat(join(this.cwd, ...segments.slice(0, i)));
        if (info.isSymbolicLink()) fail("成果文件路径包含符号链接。");
        if (i === segments.length && !info.isFile()) fail("成果白名单只能包含常规文件，禁止目录递归暂存。");
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (segments.includes(".gitattributes") || segments.includes(".gitmodules")) fail("成果不能引入 Git attributes 或子模块。");
  }
}

/** Git 命令仅用于该底座；固定配置禁外部程序、禁凭据提示，输出与执行时间均有界。 */
async function git(cwd: string, args: readonly string[], allowMissing = false, extra: Record<string, string> = {}, input?: string): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=false", "-c", "commit.gpgSign=false", ...args], {
    cwd, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Wave Flow", GIT_AUTHOR_EMAIL: "workspace@wave-flow.local", GIT_COMMITTER_NAME: "Wave Flow", GIT_COMMITTER_EMAIL: "workspace@wave-flow.local", ...extra }, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [out, err, code] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]);
    if (code !== 0 && !(allowMissing && code === 1)) throw new GitCommandError(`Git ${args[0]} 失败（${code}）：${err.slice(0, 1000)}`);
    return out;
  } finally { clearTimeout(timeout); }
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.length; if (bytes > 2_000_000) { await reader.cancel(); fail("Git 证据超过读取上限，拒绝截断后保存。"); } chunks.push(value.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
function splitPaths(text: string): string[] { return text.split("\0").filter(Boolean); }
function assertOid(oid: string): void { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) fail("必须使用已验证完整 commit oid。"); }
function assertPath(path: string): void { if (!path || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || /[\x00-\x1f\x7f\\]/.test(path)) fail("成果路径必须为安全仓库相对文件路径。"); }
function assertRequest(request: GitSaveRequest): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.requestId)) fail("保存请求必须为 UUID。"); assertOid(request.baseCommit); assertOid(request.startCommit); request.allowedPaths.forEach(assertPath); (request.mergeParents ?? []).forEach(assertOid); if (new Set(request.mergeParents ?? []).size !== (request.mergeParents ?? []).length || request.mergeParents?.includes(request.startCommit)) fail("集成父commit重复或包含起点。"); if (request.alternateObjectDirectory !== undefined && (!isAbsolute(request.alternateObjectDirectory) || !request.alternateObjectDirectory.endsWith("/objects"))) fail("私有Git对象目录无效。"); }
function assertAllowed(paths: readonly string[], allowed: readonly string[]): void { paths.forEach(assertPath); if (paths.some(path => !allowed.includes(path))) fail("现场包含未授权文件，保留现场并拒绝保存。"); }
function within(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)); }
function fail(message: string): never { throw new WorkflowContractError(message); }

/** 将writer私有对象库中tree可达对象导入受信任共享库；ref更新必须晚于此步骤。 */
export async function importGitObjects(cwd: string, tree: string, env: Record<string, string>): Promise<void> {
  assertOid(tree);
  const baseEnv: Record<string, string> = { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env };
  const pack = Bun.spawn(["/usr/bin/git", "pack-objects", "--stdout", "--revs"], { cwd, env: baseEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  pack.stdin.write(`${tree}\n`); pack.stdin.end();
  // index-pack不得继承GIT_OBJECT_DIRECTORY，否则会把导入结果仍写回scratch。
  const sharedEnv = { ...baseEnv }; delete sharedEnv.GIT_OBJECT_DIRECTORY; delete sharedEnv.GIT_INDEX_FILE;
  const index = Bun.spawn(["/usr/bin/git", "index-pack", "--stdin", "--fix-thin"], { cwd, env: sharedEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => { pack.kill(); index.kill(); }, 15_000);
  const packErrorPending = new Response(pack.stderr).text(), indexErrorPending = new Response(index.stderr).text();
  const indexOutput = new Response(index.stdout).text();
  const reader = pack.stdout.getReader(); let bytes = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 100_000_000) fail("Git对象导入超过100MB上限。"); index.stdin.write(chunk.value); }
    index.stdin.end();
    const [packCode, indexCode, packError, indexError] = await Promise.all([pack.exited, index.exited, packErrorPending, indexErrorPending, indexOutput]);
    if (packCode !== 0 || indexCode !== 0) fail(`Git对象导入失败：pack=${packCode} ${packError.slice(0,500)} index=${indexCode} ${indexError.slice(0,500)}`);
  } catch (error) { pack.kill(); index.kill(); throw error; }
  finally { clearTimeout(timeout); reader.releaseLock(); }
}
