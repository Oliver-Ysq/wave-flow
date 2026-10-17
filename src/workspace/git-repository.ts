// Git temporary-index/NUL staging adapted from BloopAI/vibe-kanban d5cbb538.
// Modified for Bun, durable candidates and explicit user merge. See third-party/NOTICE.md.
import { link, lstat, mkdtemp, open, readFile, realpath, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowContractError } from "../workflow/errors";

/** Git子进程执行失败；区别于授权/现场契约拒绝，允许有界幂等收尾重试。 */
export class GitCommandError extends WorkflowContractError {}
/** 证据超过资源上限；保存拒绝，diff展示可明确标记省略。 */
export class GitEvidenceLimitError extends WorkflowContractError {}

/** 用户审阅的冻结来源diff，不代表未提交现场或外部副作用。 */
export type GitReview = {
  /** 原冻结基准。 */ readonly baseCommit: string;
  /** 唯一完整ready来源。 */ readonly sourceCommit: string;
  /** 实际相对基准变更文件。 */ readonly paths: readonly string[];
  /** 本机分支及本次读取的HEAD，确认时须复核。 */ readonly targets: readonly { /** 本机分支短名，不含受管工作分支。 */ readonly branch: string; /** 本次审阅目标完整oid，合入时漂移则拒绝。 */ readonly head: string }[];
  /** 已耐久合入事实；重新打开页面不会误显示为未合入。 */ readonly merged?: GitMergeResult;
};
/** 单文件有界diff；不能将省略当作没有改动。 */
export type GitFileDiff = {
  /** 已核验属于冻结diff的相对路径。 */ readonly path: string;
  /** 文本patch，省略时为空。 */ readonly patch: string;
  /** 二进制或过大时为true。 */ readonly omitted: boolean;
  /** 无省略时null，其他允许值说明不能inline的原因。 */ readonly reason: "binary" | "too-large" | null;
};
/** 明确用户操作的squash请求，不支持远程push。 */
export type GitMergeRequest = {
  /** 原确认UUID；commit trailer用于崩溃重试核验。 */ readonly requestId: string;
  /** 用户已审阅基准完整oid。 */ readonly baseCommit: string;
  /** 用户已审阅完整ready来源oid。 */ readonly sourceCommit: string;
  /** 本机目标分支短名；不接受refs或选项。 */ readonly targetBranch: string;
  /** 用户确认时读取的目标HEAD，漂移则拒绝。 */ readonly targetHead: string;
};
/** 已合入本机分支的证据；不代表已push。 */
export type GitMergeResult = GitMergeRequest & {
  /** 合入后的唯一单父commit。 */ readonly commit: string;
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

/** 用户明确授权的受管成果保存请求；授权整个指定受管工作区，不授权 push/远程。 */
export type GitSaveRequest = {
  /** 独立保存请求 UUID，写入 commit trailer，关联失败后用于核验既有成果。 */
  readonly requestId: string;
  /** 原始 workspace 绑定的基准完整 oid；不得由模型预测。 */
  readonly baseCommit: string;
  /** 本次 writer 启动前 HEAD，commit 只能以该节点现场为父。 */
  readonly startCommit: string;
  /** 集成成果的额外父提交；均由Engine核验，普通writer为空。 */
  readonly mergeParents?: readonly string[];
};

/** 保存的标准 Git 证据；无改动不创建空 commit。 */
export type GitSavedResult = {
  /** 保存请求身份，用于关联去重。 */
  readonly requestId: string;
  /** 成果 commit；无改动时等于 startCommit。 */
  readonly commit: string;
  /** 本次实际提交路径，来源为整个受管工作区。 */
  readonly paths: readonly string[];
  /** true 表示未新建 commit。 */
  readonly unchanged: boolean;
};

/** 最终ready来源证据；不代表已合入目标分支。 */
export type GitSourceResult = {
  /** 原确认请求UUID。 */ readonly requestId: string;
  /** 最终来源的受管分支短名。 */ readonly branch: string;
  /** 最终来源commit完整oid。 */ readonly commit: string;
  /** 被整理的最终内部成果完整oid。 */ readonly sourceCommit: string;
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

  /** 只读审阅数据；隐藏受管内部工作分支作为目标，仍由merge重新核验。 */
  async review(baseCommit: string, sourceCommit: string): Promise<GitReview> {
    await this.assertIdentity(); await this.assertSafe();
    const paths = await this.changedBetween(baseCommit, sourceCommit);
    const targets = (await git(this.cwd, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"])).trim().split("\n").filter(Boolean).map(line => {
      const [branch, head] = line.split(" "); return { branch, head };
    }).filter(target => !target.branch.startsWith("codex/wf-") && !target.branch.startsWith("codex/delivery-"));
    return { baseCommit, sourceCommit, paths, targets };
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

  /** Kanban式单父squash：目标前进/dirty拒绝，未checkout只CAS ref，已checkout同步安全更新现场。
   * 不改来源refs，不push；原请求重试识别同commit并补checkout，不新增commit。
   */
  async mergeSquash(
    /** 用户确认的冻结来源与目标，不能自动选取。 */ request: GitMergeRequest,
    /** 安全预检后、任何ref更新前耐久原请求；独立Git测试可省略。 */ persistIntent?: () => Promise<void>,
  ): Promise<GitMergeResult> {
    assertOid(request.baseCommit); assertOid(request.sourceCommit); assertOid(request.targetHead);
    if (!/^[a-f0-9-]{36}$/.test(request.requestId) || request.targetBranch.startsWith("-") || request.targetBranch.startsWith("refs/") || request.targetBranch.startsWith("codex/wf-") || request.targetBranch.startsWith("codex/delivery-")) fail("合入请求身份或目标分支无效。");
    await git(this.cwd, ["check-ref-format", "--branch", request.targetBranch]);
    await this.assertIdentity(); await this.assertSafe();
    const ref = `refs/heads/${request.targetBranch}`, head = await this.commitOid(ref);
    const tree = (await git(this.cwd, ["rev-parse", `${request.sourceCommit}^{tree}`])).trim();
    const message = `Wave Flow squash merge\n\nWave-Flow-Merge: ${request.requestId}\nWave-Flow-Source: ${request.sourceCommit}\nWave-Flow-Base: ${request.baseCommit}\nWave-Flow-Target: ${request.targetHead}`;
    const retry = head !== request.targetHead;
    if (retry && ((await git(this.cwd, ["show", "-s", "--format=%B", head])).trimEnd() !== message || (await git(this.cwd, ["show", "-s", "--format=%P", head])).trim() !== request.targetHead || (await git(this.cwd, ["rev-parse", `${head}^{tree}`])).trim() !== tree)) fail("目标分支已变化；请重新审阅，不能覆盖。");
    if (request.targetHead !== request.baseCommit) fail("目标分支已偏离冻结基准；请先显式集成目标变化并重新审阅。");
    await git(this.cwd, ["merge-base", "--is-ancestor", request.baseCommit, request.sourceCommit]);
    const worktrees = (await git(this.cwd, ["worktree", "list", "--porcelain", "-z"])).split("\0");
    let checkout: string | null = null, path = "";
    for (const field of worktrees) { if (field.startsWith("worktree ")) path = field.slice(9); if (field === `branch ${ref}`) checkout = path; }
    if (checkout) {
      const repo = await GitRepository.open(checkout), state = await repo.inspect();
      if (state.commonDirectory !== this.commonDirectory || state.branch !== ref || state.conflicts.length) fail("目标checkout身份或冲突现场无效。");
      const affected = await this.changedBetween(request.targetHead, request.sourceCommit);
      if (state.ignoredPaths.some(ignored => affected.some(file => file===ignored || file.startsWith(ignored+"/") || ignored.startsWith(file+"/")))) fail("目标工作区存在会被覆盖的ignored或排除文件；请先处理。");
      const staged = await git(checkout,["diff","--cached","--no-ext-diff","--no-textconv","--name-only","-z","--"]);
      if (!retry && (state.changedPaths.length || staged)) fail("目标工作区存在未提交/暂存/未跟踪文件；请先处理，不自动提交或覆盖。");
      if (retry && !state.changedPaths.length && staged) fail("合入后目标暂存区已变化，不能自动补checkout。");
      const directory = await repo.gitDirectory();
      for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        try { await lstat(join(directory,name)); fail("目标工作区仍有Git操作进行中。"); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
      }
      if (retry && state.changedPaths.length) {
        // CAS之后崩溃时index可能仍为旧tree，仅恢复精确旧现场；用户后续变化不能覆盖。
        if ((await git(checkout, ["write-tree"])).trim() !== (await git(checkout, ["rev-parse", `${request.targetHead}^{tree}`])).trim()
          || await git(checkout, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--"]) || await git(checkout, ["ls-files", "--others", "--exclude-standard"])) fail("合入后目标现场已变化，不能自动补checkout。");
      }
    }
    await persistIntent?.();
    const commit = retry ? head : (await git(this.cwd, ["commit-tree", tree, "-p", request.targetHead], false, {}, message+"\n")).trim();
    if (!retry) await git(this.cwd, ["update-ref", ref, commit, request.targetHead]);
    if (checkout) await git(checkout, ["read-tree", "-u", "-m", request.targetHead, commit]);
    return { ...request, commit };
  }

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

  /** 集成前重新核验真实commit与父提交范围，不能只相信Workspace JSON中的hash。 */
  async verifySavedCommit(commit: string, startCommit?: string, expectedPaths?: readonly string[]): Promise<void> {
    assertOid(commit);
    if (await this.commitOid(commit) !== commit) fail("成果commit不可验证。");
    if (startCommit) {
      assertOid(startCommit);
      await git(this.cwd, ["merge-base", "--is-ancestor", startCommit, commit]);
      const paths = splitPaths(await git(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", startCommit, commit, "--"])).sort();
      paths.forEach(assertPath);
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
  async verifyCommitObject(commit: string, startCommit: string, expectedPaths: readonly string[]): Promise<void> {
    assertOid(commit); assertOid(startCommit); expectedPaths.forEach(assertPath);
    if (await this.commitOid(commit) !== commit) fail("成果commit不可验证。");
    await git(this.cwd, ["merge-base", "--is-ancestor", startCommit, commit]);
    const paths=splitPaths(await git(this.cwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",startCommit,commit,"--"])).sort();
    paths.forEach(assertPath);if(JSON.stringify(paths)!==JSON.stringify([...expectedPaths].sort()))fail("成果commit文件范围与耐久关联不一致。");
  }

  /** 核验最终来源的Git父链覆盖每份独立成果，不凭声明推断已集成。 */
  async containsCommit(source: string, ancestor: string): Promise<boolean> {
    assertOid(source); assertOid(ancestor);
    return (await git(this.cwd, ["merge-base", ancestor, source])).trim() === ancestor;
  }

  /** writer 已退出后调用；保存实际Git改动，已有同请求 commit 时复核后返回而非重复提交。 */
  async save(request: GitSaveRequest): Promise<GitSavedResult> {
    assertRequest(request);
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
      // update-ref 成功后、index 刷新前进程可能中断。先比较工作区字节对应树，再恢复索引。
      await this.assertTreeMatchesHead();
      await git(this.cwd, ["read-tree", state.head]);
      if (request.mergeParents?.length) await git(this.cwd, ["merge", "--quit"]);
      return { requestId: request.requestId, commit: state.head, paths, unchanged: false };
    }
    if (!state.changedPaths.length && !request.mergeParents?.length) {
      try { await lstat(join(await this.gitDirectory(),`wf-save-${request.requestId}.json`)); fail("保存候选已冻结，现场发生变化；不能返回无改动。"); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
      return { requestId: request.requestId, commit: state.head, paths: [], unchanged: true };
    }
    for (const path of state.changedPaths) await this.assertFilePath(path);
    const temp = await mkdtemp(join(await this.gitDirectory(), "wf-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await git(this.cwd, ["read-tree", state.head], false, env);
      // 路径已经由tracked diff + exclude-standard untracked核定，-f仅避免新ignore规则拒绝tracked文件。
      if (state.changedPaths.length) await git(this.cwd, ["--literal-pathspecs", "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], false, env, state.changedPaths.join("\0")+"\0");
      let tree = (await git(this.cwd, ["write-tree"], false, env)).trim();
      if (!request.mergeParents?.length && tree === (await git(this.cwd,["rev-parse","HEAD^{tree}"])).trim()) fail("暂存区与工作文件不一致但工作内容等于HEAD；请先处理现场，不清空暂存或制造空成果。");
      // 同请求候选以Git tree耐久冻结；失败重试不重新解释后来产生的成果。
      const intent = join(await this.gitDirectory(), `wf-save-${request.requestId}.json`);
      const candidate = { request, tree, paths: [...state.changedPaths].sort() };
      const intentTemp = `${intent}.${crypto.randomUUID()}.tmp`;
      try {
        const file = await open(intentTemp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(candidate)); await file.sync(); } finally { await file.close(); }
        // hard-link发布完整已fsync的常规文件；EEXIST不覆盖原候选，避免半份JSON成为权威。
        await link(intentTemp, intent);
        const directory = await open(await this.gitDirectory(), "r"); try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(intent); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail("Git候选意图文件不安全。");
        const frozen = JSON.parse(await readFile(intent, "utf8"));
        if (JSON.stringify(frozen.request) !== JSON.stringify(request) || frozen.tree !== tree || JSON.stringify(frozen.paths) !== JSON.stringify([...state.changedPaths].sort())) fail("保存候选已冻结，现场或请求发生变化；不能重新收集覆盖。");
        tree = frozen.tree;
      } finally { await unlink(intentTemp).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}); }
      const modes = splitPaths(await git(this.cwd, ["ls-tree", "-r", "-z", tree], false, env));
      if (modes.some(entry => !/^(100644|100755) blob /.test(entry))) fail("候选tree包含不支持的文件模式。");
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

  private async assertTreeMatchesHead(): Promise<void> {
    const temp = await mkdtemp(join(await this.gitDirectory(), "wf-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await git(this.cwd, ["read-tree", "HEAD"], false, env);
      const paths = (await this.inspect()).changedPaths;
      for (const path of paths) await this.assertFilePath(path);
      if (paths.length) await git(this.cwd, ["--literal-pathspecs", "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], false, env, paths.join("\0")+"\0");
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
function assertRequest(request: GitSaveRequest): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.requestId)) fail("保存请求必须为 UUID。"); assertOid(request.baseCommit); assertOid(request.startCommit); (request.mergeParents ?? []).forEach(assertOid); if (new Set(request.mergeParents ?? []).size !== (request.mergeParents ?? []).length || request.mergeParents?.includes(request.startCommit)) fail("集成父commit重复或包含起点。"); }
function within(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)); }
function fail(message: string): never { throw new WorkflowContractError(message); }
