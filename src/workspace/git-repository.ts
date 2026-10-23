// Git temporary-index/NUL staging adapted from BloopAI/vibe-kanban d5cbb538.
// Modified for Bun, durable candidates and explicit user merge. See third-party/NOTICE.md.
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowContractError } from "../workflow/errors";

/** Git子进程执行失败；区别于授权/现场契约拒绝，允许有界幂等收尾重试。 */
export class GitCommandError extends WorkflowContractError {}
/** 证据超过资源上限；保存拒绝，diff展示可明确标记省略。 */
export class GitEvidenceLimitError extends WorkflowContractError {}

/** 用户审阅的执行前后diff，不代表未提交现场或外部副作用。 */
export type GitReview = {
  /** 原冻结基准。 */ readonly baseCommit: string;
  /** 本次Execution最终封存commit。 */ readonly sourceCommit: string;
  /** 实际相对基准变更文件。 */ readonly paths: readonly string[];
};
/** 单文件有界diff；不能将省略当作没有改动。 */
export type GitFileDiff = {
  /** 已核验属于冻结diff的相对路径。 */ readonly path: string;
  /** 文本patch，省略时为空。 */ readonly patch: string;
  /** 二进制或过大时为true。 */ readonly omitted: boolean;
  /** 无省略时null，其他允许值说明不能inline的原因。 */ readonly reason: "binary" | "too-large" | null;
};
/** 一次Execution的最终封存请求；只提交到受管分支，不移动主工作区。 */
export type GitSealRequest = {
  /** 原Execution UUID，写入 commit trailer 用于幂等核验。 */
  readonly requestId: string;
  /** 执行前冻结的基准完整 oid；最终diff以它为起点。 */
  readonly baseCommit: string;
  /** 交接时的worktree HEAD；封存commit必须包含其全部历史。 */
  readonly startCommit: string;
};

/** Git 可见现场；不是外部副作用快照，不读取 ignored 文件正文。 */
export type GitWorkspaceState = {
  /** canonical worktree 根目录，身份变化时拒绝使用。 */
  readonly cwd: string;
  /** canonical 共享 Git 元数据目录，用于区分不同仓库。 */
  readonly commonDirectory: string;
  /** 当前worktree专属Git元数据目录，用于身份复核；不是权限边界。 */
  readonly gitDirectory: string;
  /** 工作区 HEAD 的完整 commit oid。 */
  readonly head: string;
  /** 当前分支全名；detached HEAD 为 null。 */
  readonly branch: string | null;
  /** 相对HEAD的工作文件、暂存区及非ignored untracked差异；重命名按删除与新增，暂存差异也阻止交接。 */
  readonly changedPaths: readonly string[];
  /** 尚未解决的冲突路径；非空时不能交付。 */
  readonly conflicts: readonly string[];
  /** Git忽略的现场文件；不纳入commit，但阻止自动清理，避免删除未知依赖/凭据。 */
  readonly ignoredPaths: readonly string[];
};

/** 保存的标准 Git 证据；无改动不创建空 commit。 */
export type GitSavedResult = {
  /** 封存请求身份，用于关联去重。 */
  readonly requestId: string;
  /** 成果 commit；无改动时等于当前HEAD。 */
  readonly commit: string;
  /** 相对冻结基准的全部变更路径。 */
  readonly paths: readonly string[];
  /** true 表示未新建 commit。 */
  readonly unchanged: boolean;
};

/** 最终ready来源证据；不代表已合入目标分支。 */
export type GitSourceResult = {
  /** 原确认请求UUID。 */ readonly requestId: string;
  /** 最终来源的受管分支短名。 */ readonly branch: string;
  /** 最终来源commit完整oid；Execution最终封存的唯一成果commit。 */ readonly commit: string;
  /** 相对冻结基准实际变化文件。 */ readonly paths: readonly string[];
};

/** 固定 Git argv、禁 hooks/外部 diff/filter 的受管 Git 底座；不负责 writer 生命周期。 */
export class GitRepository {
  private constructor(readonly cwd: string, readonly commonDirectory: string) {}

  /** 读取冻结commit之间的实际路径；不读取当前未保存现场。 */
  async changedBetween(base: string, source: string): Promise<string[]> {
    assertOid(base); assertOid(source);
    const paths = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, source, "--"])).sort();
    paths.forEach(assertPath); return paths;
  }

  /** 只读审阅数据：执行冻结基准到最终封存commit的全部变更。 */
  async review(baseCommit: string, sourceCommit: string): Promise<GitReview> {
    await this.assertIdentity();
    const paths = await this.changedBetween(baseCommit, sourceCommit);
    return { baseCommit, sourceCommit, paths };
  }

  /** 按已保存的Git对象加载文件patch，不允许任意路径读取。 */
  async fileDiff(base: string, source: string, path: string): Promise<GitFileDiff> {
    if (!(await this.changedBetween(base, source)).includes(path)) fail("文件不属于冻结成果diff。");
    const numstat = await git(this.cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--numstat", base, source, "--", path]);
    if (numstat.startsWith("-\t-\t")) return { path, patch: "", omitted: true, reason: "binary" };
    try {
      const patch = await git(this.cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, source, "--", path]);
      return { path, patch, omitted: false, reason: null };
    } catch (error) {
      if (error instanceof GitEvidenceLimitError) return { path, patch: "", omitted: true, reason: "too-large" };
      throw error;
    }
  }

  /** 把共享worktree的当前文件封存为一个受管commit；不移动主工作区分支，不push。
   * 同一Execution重试识别已封存HEAD并复用，不重复制造commit。
   * 已知取舍：与旧逐节点save的“意图文件冻结候选tree”不同，崩溃后的重试会重新收集现场；
   * 安全性由调用方保证（finalizeSource要求租约全空且全程持有排他锁），暴露面只剩外部进程
   * 在两次重试之间改动受管worktree，故不再单独冻结候选。
   */
  async seal(request: GitSealRequest): Promise<GitSavedResult> {
    if (!/^[0-9a-f-]{36}$/.test(request.requestId)) fail("封存请求必须为UUID。");
    assertOid(request.baseCommit); assertOid(request.startCommit);
    const state = await this.inspect();
    if (await this.gitDirectory() === this.commonDirectory || !state.branch?.startsWith("refs/heads/codex/wf-")) fail("禁止封存主工作区或非受管分支。");
    if (state.conflicts.length) fail("尚有未解决冲突，成果不可封存。");
    await git(this.cwd, ["merge-base", "--is-ancestor", request.baseCommit, state.head]);
    await git(this.cwd, ["merge-base", "--is-ancestor", request.startCommit, state.head]);
    const headTree = (await git(this.cwd, ["rev-parse", "HEAD^{tree}"])).trim();
    const tree = await this.worktreeTree(state.changedPaths);
    const message = `Wave Flow managed seal\n\nWave-Flow-Seal: ${request.requestId}`;
    const body = (await git(this.cwd, ["show", "-s", "--format=%B", state.head])).trimEnd();
    const sealed = body === message;
    if (sealed) {
      if (tree !== headTree) fail("封存后现场已变化；请修订方案，不重复制造成果。");
      // update-ref 成功后、read-tree 前中断时索引仍是旧tree；同一请求重试先修复索引，避免worktree永久显示为脏。
      await this.resetIndexToHeadIfStaged();
      return { requestId: request.requestId, commit: state.head, paths: await this.changedBetween(request.baseCommit, state.head), unchanged: true };
    }
    if (tree === headTree) {
      const staged = splitPaths(await git(this.cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"]));
      if (staged.length) fail("暂存区与工作文件不一致但工作内容等于HEAD；请先处理现场，不清空暂存或制造空成果。");
      // 无新内容时不制造空commit，但不能把其他Execution/其他补收尾的封存HEAD冒充本次来源。
      const foreign = /\nWave-Flow-Seal: ([0-9a-f-]{36})\n?$/.exec(body)?.[1] ?? null;
      if (foreign !== null && foreign !== request.requestId && state.head !== request.startCommit) fail("当前HEAD是其他封存来源；不能把本次执行结果指向它。");
      return { requestId: request.requestId, commit: state.head, paths: await this.changedBetween(request.baseCommit, state.head), unchanged: true };
    }
    const commit = (await git(this.cwd, ["commit-tree", tree, "-p", state.head, "-m", `${message}\n`])).trim();
    assertOid(commit);
    // compare-and-swap 保证封存不能覆盖封存期间的外部提交。
    await git(this.cwd, ["update-ref", state.branch, commit, state.head]);
    await git(this.cwd, ["read-tree", commit]);
    return { requestId: request.requestId, commit, paths: await this.changedBetween(request.baseCommit, commit), unchanged: false };
  }

  /** 把封存tree精确写入主工作区，保持未提交；HEAD前进/冲突/其他未提交改动时拒绝覆盖。 */
  async applyCommit(commit: string, baseCommit: string, expectedWorktree?: string): Promise<readonly string[]> {
    assertOid(commit); assertOid(baseCommit);
    if (expectedWorktree !== undefined) assertOid(expectedWorktree);
    await this.assertIdentity();
    const state = await this.inspect();
    if (state.branch === null) fail("主工作区处于 detached HEAD；未自动应用。");
    if (state.head !== baseCommit) fail("主工作区当前HEAD已偏离冻结基准；未自动应用。");
    if (state.conflicts.length) fail("主工作区存在未解决冲突；未自动应用。");
    const targetTree = (await git(this.cwd, ["rev-parse", `${commit}^{tree}`])).trim();
    assertOid(targetTree);
    const headTree = (await git(this.cwd, ["rev-parse", "HEAD^{tree}"])).trim();
    // 以应用前现场为索引基线收集工作文件，才能把上一次应用落下的 ignored/tracked 文件也纳入核对。
    const currentTree = await this.worktreeTree(state.changedPaths, expectedWorktree ?? "HEAD");
    const indexTree = (await git(this.cwd, ["write-tree"])).trim();
    assertOid(indexTree);
    const paths = await this.changedBetween(baseCommit, commit);
    // 首次应用且相对基准没有任何文件改动：主工作区无需写入，不能因用户dirty而误报“未自动应用”。
    if (!expectedWorktree && targetTree === headTree) return paths;
    // 工作文件已经等于目标tree：应用已完整生效或重复收尾；只修复索引，不重复写现场。
    if (currentTree === targetTree) {
      if (indexTree === targetTree) await git(this.cwd, ["reset", "--mixed", "HEAD"]);
      else if (indexTree !== headTree) fail("主工作区暂存区存在本次执行之外的改动；未自动应用。");
      return paths;
    }
    if (!expectedWorktree) {
      if (state.changedPaths.length) fail("主工作区存在未提交改动；未自动覆盖。");
    } else {
      assertOid(expectedWorktree);
      const expectedTree = (await git(this.cwd, ["rev-parse", `${expectedWorktree}^{tree}`])).trim();
      if (currentTree !== expectedTree) fail("主工作区存在本次执行之外的未提交改动；未自动覆盖。");
    }
    if (indexTree !== headTree) fail("主工作区暂存区存在本次执行之外的改动；未自动覆盖。");
    if (state.ignoredPaths.some(ignored => paths.some(file => file === ignored || file.startsWith(ignored + "/") || ignored.startsWith(file + "/")))) fail("主工作区存在会被覆盖的ignored文件；未自动应用。");
    // inspect 到 read-tree 之间主工作区无法加锁：用户恰在此窗口commit时其工作文件会被
    // 封存tree覆盖（HEAD不动，内容可从其commit恢复）。窗口极小，已接受。
    // 接续执行先把索引设为上一次应用结果，read-tree -u 才能删除上一次应用新增、本次回退或删除的文件。
    if (expectedWorktree) await git(this.cwd, ["read-tree", expectedWorktree]);
    await git(this.cwd, ["read-tree", "-u", "--reset", commit]);
    // 只更新工作文件与索引，不移动分支；重置索引让改动保持未暂存、未提交。
    await git(this.cwd, ["reset", "--mixed", "HEAD"]);
    return paths;
  }

  /** 索引与HEAD不同但工作文件等于HEAD时，把索引恢复为HEAD tree；用于封存中断后的幂等修复。 */
  private async resetIndexToHeadIfStaged(): Promise<void> {
    const staged = splitPaths(await git(this.cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"]));
    if (staged.length) await git(this.cwd, ["read-tree", "HEAD"]);
  }

  /** 只读打开仓库根目录，拒绝软链接入口、非根目录及不安全仓库特性。 */
  static async open(path: string): Promise<GitRepository> {
    if (!isAbsolute(path) || (await lstat(path)).isSymbolicLink()) fail("Git 工作区必须为非软链接绝对目录。");
    const cwd = await realpath(path);
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(root) !== cwd) fail("Git 工作区必须绑定仓库根目录。");
    const commonDirectory = await realpath(resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()));
    const repo = new GitRepository(cwd, commonDirectory);
    await repo.commitOid("HEAD");
    return repo;
  }

  /** 读取当前 Git 可见证据；关闭外部 diff/textconv，不将无改动解释为没有外部影响。 */
  async inspect(): Promise<GitWorkspaceState> {
    await this.assertIdentity();
    const head = await this.commitOid("HEAD");
    const branch = (await git(this.cwd, ["symbolic-ref", "-q", "HEAD"], true)).trim() || null;
    const tracked = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"]));
    const staged = splitPaths(await git(this.cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"]));
    const untracked = splitPaths(await git(this.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const conflicts = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U", "-z", "--"]));
    const ignoredPaths=[...splitPaths(await git(this.cwd,["ls-files","--others","--ignored","--exclude-standard","-z"])), ...untracked.filter(path => path.split("/").includes("node_modules"))];
    return { cwd: this.cwd, commonDirectory: this.commonDirectory, gitDirectory: await this.gitDirectory(), head, branch, changedPaths: [...new Set([...tracked, ...staged, ...untracked.filter(path => !path.split("/").includes("node_modules"))])].sort(), conflicts,ignoredPaths };
  }

  /** 当前Git可见现场指纹；包括改动正文/删除/模式，忽略内容和外部系统不覆盖，变动中拒绝。 */
  async sceneFingerprint(): Promise<{ readonly hash: string; readonly state: GitWorkspaceState }> {
    const state = await this.inspect();
    const index = await git(this.cwd, ["ls-files", "--stage", "-z"]);
    const hash = createHash("sha256").update(JSON.stringify([state,index]));
    let bytes = 0;
    for (const path of state.changedPaths) {
      const absolute = resolve(this.cwd, path);
      const inside = relative(this.cwd, absolute);
      if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) fail("现场证据路径越界。");
      hash.update(JSON.stringify(path));
      let handle;
      try {
        if (await realpath(join(absolute, "..")) !== join(absolute, "..")) fail("现场证据父目录包含软链接。");
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { hash.update("deleted"); continue; }
        throw error;
      }
      try {
        const before = await handle.stat();
        bytes += before.size;
        if (!before.isFile() || bytes > 16 * 1024 * 1024) fail("当前现场证据无法完整核验或超过16MiB。");
        hash.update(JSON.stringify([before.mode, before.size]));
        const content = await handle.readFile();
        if (content.length !== before.size) fail("现场读取期间文件长度变化，请重新检查。");
        hash.update(content);
        const after = await handle.stat();
        const current = await lstat(absolute);
        if (await realpath(join(absolute, "..")) !== join(absolute, "..")
          || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) fail("现场读取期间发生变化或文件替换，请重新检查。");
      } finally { await handle.close(); }
    }
    if (JSON.stringify(await this.inspect()) !== JSON.stringify(state) || await git(this.cwd, ["ls-files", "--stage", "-z"]) !== index) fail("现场读取期间Git状态或暂存区变化，请重新检查。");
    return { hash: hash.digest("hex"), state };
  }

  /** 从明确已验证 commit 新建独立 worktree；不复制、暂存或提交主工作区 dirty 内容。 */
  async createWorktree(directory: string, branch: string, baseCommit: string): Promise<GitRepository> {
    await this.assertIdentity();
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
    await this.assertIdentity();
    if (!isAbsolute(directory) || within(this.cwd, directory) || within(this.commonDirectory, directory)) fail("只能清理主工作区外的受管worktree。");
    const target = await GitRepository.open(directory), state = await target.inspect();
    if (target.commonDirectory !== this.commonDirectory || state.changedPaths.length || state.conflicts.length || state.ignoredPaths.length) fail("worktree仍有未提交/ignored内容或冲突，拒绝清理。");
    await git(this.cwd, ["worktree", "remove", "--", directory]);
  }

  /** 仅核验commit对象存在且完整；用于checkout已清理后的清理重试，不要求当前HEAD。 */
  async verifyCommitExists(commit: string): Promise<void> {
    assertOid(commit);
    if (await this.commitOid(commit) !== commit) fail("成果commit不可验证。");
  }

  /** 核验最终来源的Git父链覆盖每份独立成果，不凭声明推断已集成。 */
  async containsCommit(source: string, ancestor: string): Promise<boolean> {
    assertOid(source); assertOid(ancestor);
    return (await git(this.cwd, ["merge-base", ancestor, source])).trim() === ancestor;
  }

  /** 用临时索引把当前共享worktree的文件收集为一个tree；不改变真实索引或HEAD。
   * baseRef 缺省为HEAD；接续应用传入上一次应用结果，使只在主工作区表现为ignored的已应用文件仍进入核对。 */
  private async worktreeTree(paths: readonly string[], baseRef: string = "HEAD"): Promise<string> {
    const temp = await mkdtemp(join(await this.gitDirectory(), "wf-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await git(this.cwd, ["read-tree", baseRef], false, env);
      for (const path of paths) await this.assertFilePath(path);
      // 路径已经由tracked diff + exclude-standard untracked核定，-f仅避免新ignore规则拒绝tracked文件。
      if (paths.length) await git(this.cwd, ["--literal-pathspecs", "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], false, env, paths.join("\0") + "\0");
      const tree = (await git(this.cwd, ["write-tree"], false, env)).trim();
      assertOid(tree);
      const modes = splitPaths(await git(this.cwd, ["ls-tree", "-r", "-z", tree], false, env));
      // 允许保留仓库原有、未被本次成果修改的 symlink/gitlink；新增或修改这些路径
      // 会在 worktreeTree 的 assertFilePath 阶段拒绝，不能借放宽模式绕过。
      if (modes.some(entry => !/^(?:(?:100644|100755|120000) blob |160000 commit )/.test(entry))) fail("候选tree包含不支持的文件模式。");
      return tree;
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

  private async assertFilePath(path: string): Promise<void> {
    assertPath(path);
    const segments = path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      try {
        const info = await lstat(join(this.cwd, ...segments.slice(0, i)));
        if (info.isSymbolicLink()) fail("成果文件路径包含符号链接。");
        if (i === segments.length && !info.isFile()) fail("成果只能包含常规文件，禁止目录递归暂存。");
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
  } catch (error) { child.kill(); throw error; } finally { clearTimeout(timeout); }
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.length; if (bytes > 2_000_000) { await reader.cancel(); throw new GitEvidenceLimitError("Git 证据超过读取上限，拒绝截断后保存。"); } chunks.push(value.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
function splitPaths(text: string): string[] { return text.split("\0").filter(Boolean); }
function assertOid(oid: string): void { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) fail("必须使用已验证完整 commit oid。"); }
function assertPath(path: string): void { if (!path || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || /[\x00-\x1f\x7f\\]/.test(path)) fail("成果路径必须为安全仓库相对文件路径。"); }
function within(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)); }
function fail(message: string): never { throw new WorkflowContractError(message); }
