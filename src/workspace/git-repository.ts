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
  /** 本次Execution最终证据tree；不创建commit。 */ readonly sourceTree: string;
  /** 实际相对基准变更文件。 */ readonly paths: readonly string[];
};
/** 单文件有界diff；不能将省略当作没有改动。 */
export type GitFileDiff = {
  /** 已核验属于冻结diff的相对路径。 */ readonly path: string;
  /** 文本patch，省略时为空。 */ readonly patch: string;
  /** 二进制或过大时为true。 */ readonly omitted: boolean;
  /** 无省略时null，其他允许值说明不能inline的原因。 */ readonly reason: "binary" | "too-large" | null;
};
/** 一次Execution的最终证据请求；只写证据ref，不创建commit、不移动主工作区。 */
export type GitEvidenceRequest = {
  /** 原Execution UUID，写入证据ref名用于幂等核验。 */
  readonly requestId: string;
  /** 执行前冻结的基准完整 oid；最终diff以它为起点。 */
  readonly baseCommit: string;
  /** 交接时的worktree HEAD；证据必须包含其全部历史。 */
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
};

/** 一次Execution的tree级Git证据；不创建commit，无改动时复用当前HEAD tree。 */
export type GitEvidence = {
  /** 证据请求身份，用于关联去重。 */
  readonly requestId: string;
  /** 现场收集得到的tree完整oid。 */
  readonly tree: string;
  /** 指向该tree的证据ref全名（refs/wave-flow/evidence/<requestId>）。 */
  readonly evidenceRef: string;
  /** 相对冻结基准的全部变更路径。 */
  readonly paths: readonly string[];
};

/** 固定 Git argv、禁 hooks/外部 diff/filter 的受管 Git 底座；不负责 writer 生命周期。 */
export class GitRepository {
  private constructor(readonly cwd: string, readonly commonDirectory: string) {}

  /** 读取冻结commit之间的实际路径；不读取当前未保存现场。流式完整读取，无截断。 */
  async changedBetween(base: string, source: string): Promise<string[]> {
    assertOid(base); assertOid(source);
    const paths = (await gitPaths(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, source, "--"])).sort();
    paths.forEach(assertPath); return paths;
  }

  /** 只读审阅数据：执行冻结基准到最终证据tree的全部变更。 */
  async review(baseCommit: string, sourceTree: string): Promise<GitReview> {
    await this.assertIdentity();
    const paths = await this.changedBetween(baseCommit, sourceTree);
    return { baseCommit, sourceTree, paths };
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

  /** 把共享worktree的当前文件收集为一个tree并写入证据ref；不创建commit、不移动HEAD/真实索引/主工作区。
   * 同一Execution重试重写同一证据ref（tree一致则幂等）。
   * 已知取舍：与逐节点save的“意图文件冻结候选tree”相同，崩溃后的重试会重新收集现场；
   * 安全性由调用方保证（finalize要求租约全空且全程持有排他锁），暴露面只剩外部进程
   * 在两次重试之间改动受管worktree。
   */
  async captureEvidence(request: GitEvidenceRequest): Promise<GitEvidence> {
    if (!/^[0-9a-f-]{36}$/.test(request.requestId)) fail("证据请求必须为UUID。");
    assertOid(request.baseCommit); assertOid(request.startCommit);
    const state = await this.inspect();
    if (await this.gitDirectory() === this.commonDirectory || !state.branch?.startsWith("refs/heads/codex/wf-")) fail("禁止采集主工作区或非受管分支。");
    if (state.conflicts.length) fail("尚有未解决冲突，成果不可采集。");
    // merge-base --is-ancestor 的 exit 1 是确定性“非祖先”语义，不是 Git 故障：
    // 必须不可重试拒绝，禁止宿主每次启动重复注定失败的 finalize；只有 >1/信号才是可重试故障。
    await assertAncestor(this.cwd, request.baseCommit, state.head, "冻结基准");
    await assertAncestor(this.cwd, request.startCommit, state.head, "交接基准");
    const tree = await this.worktreeTree(state.changedPaths);
    const evidenceRef = `refs/wave-flow/evidence/${request.requestId}`;
    // compare-and-swap 语义不适用（treeref可重复写）；重试只重写本请求的ref。
    await git(this.cwd, ["update-ref", evidenceRef, tree]);
    return { requestId: request.requestId, tree, evidenceRef, paths: await this.changedBetween(request.baseCommit, tree) };
  }

  /** 只读核验证据ref存在且tree与expected一致（expected可为历史commit tree-ish）；一致返回canonical tree。 */
  async verifyEvidenceExists(ref: string, expected: string): Promise<string> {
    const actual = (await git(this.cwd, ["rev-parse", "--verify", `${ref}^{tree}`])).trim();
    const wanted = (await git(this.cwd, ["rev-parse", "--verify", `${expected}^{tree}`])).trim();
    assertOid(actual); assertOid(wanted);
    if (actual !== wanted) fail("证据tree与期望不一致。");
    return actual;
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

  /** 读取当前 Git 可见证据；关闭外部 diff/textconv，不将无改动解释为没有外部影响。
   * 路径列表流式完整读取：不受 2MiB 证据读取上限约束（大列表合法现场不再永久拒绝交付），
   * 非法 UTF-8 文件名明确拒绝，禁止 U+FFFD 替代字符被当作真实路径。 */
  async inspect(): Promise<GitWorkspaceState> {
    await this.assertIdentity();
    const head = await this.commitOid("HEAD");
    const branch = (await git(this.cwd, ["symbolic-ref", "-q", "HEAD"], true)).trim() || null;
    const tracked = await gitPaths(this.cwd, ["diff", "--ignore-submodules=none", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"]);
    const staged = await gitPaths(this.cwd, ["diff", "--cached", "--ignore-submodules=none", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"]);
    const untracked = await gitPaths(this.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const conflicts = await gitPaths(this.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U", "-z", "--"]);
    return { cwd: this.cwd, commonDirectory: this.commonDirectory, gitDirectory: await this.gitDirectory(), head, branch, changedPaths: [...new Set([...tracked, ...staged, ...untracked])].sort(), conflicts };
  }

  /** 当前Git可见现场指纹；包括改动正文/删除/模式，忽略内容和外部系统不覆盖，变动中拒绝。 */
  async sceneFingerprint(): Promise<{ readonly hash: string; readonly state: GitWorkspaceState }> {
    const state = await this.inspect();
    // 索引列表只参与指纹：流式摘要，避免大仓库（文件数多）仅因列表超过证据读取上限而失败。
    const indexDigest = await gitDigest(this.cwd, ["ls-files", "--stage", "-z"]);
    const hash = createHash("sha256").update(JSON.stringify([state,indexDigest]));
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
    if (JSON.stringify(await this.inspect()) !== JSON.stringify(state) || await gitDigest(this.cwd, ["ls-files", "--stage", "-z"]) !== indexDigest) fail("现场读取期间Git状态或暂存区变化，请重新检查。");
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
    await git(this.cwd, ["worktree", "add", "--no-track", "-b", branch, "--", directory, baseCommit], false, {}, undefined, 180_000);
    return GitRepository.open(directory);
  }

  /** 用户批准后只移除身份、注册和tree均匹配的受管worktree；ignored可删除，锁、嵌套worktree与已初始化submodule不可绕过。 */
  async removeWorktree(directory: string, expectedTree: string, expectedIdentity: Pick<GitWorkspaceState, "gitDirectory" | "branch">): Promise<void> {
    await this.assertIdentity();
    if (!isAbsolute(directory) || within(this.cwd, directory) || within(this.commonDirectory, directory)) fail("只能清理主工作区外的受管worktree。");
    const target = await GitRepository.open(directory), state = await target.inspect();
    if (target.commonDirectory !== this.commonDirectory || state.gitDirectory !== expectedIdentity.gitDirectory || state.branch !== expectedIdentity.branch) fail("worktree身份与冻结记录不一致，拒绝清理。");
    if (state.conflicts.length) fail("worktree仍有未解决冲突，拒绝清理。");
    await this.assertRemovalRegistration(target);
    await this.assertNoPopulatedSubmodules(target);
    const current = await target.worktreeTree(state.changedPaths);
    const expected = (await git(this.cwd, ["rev-parse", "--verify", `${expectedTree}^{tree}`])).trim();
    assertOid(expected);
    if (current !== expected) fail("worktree现场已偏离已采集证据，拒绝清理。");
    await git(this.cwd, ["worktree", "remove", "--force", "--", directory], false, {}, undefined, null);
  }

  /** Git注册是删除依据；locked与嵌套注册checkout均需人工处理，不能由父目录force删除吞掉。 */
  private async assertRemovalRegistration(target: GitRepository): Promise<void> {
    const entries: { path: string; locked: boolean }[] = [];
    for (const entry of parseWorktreeList(await git(this.cwd, ["worktree", "list", "--porcelain", "-z"], false, {}, undefined, 15_000, true))) {
      try { entries.push({ ...entry, path: await realpath(entry.path) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const registered = entries.find(entry => entry.path === target.cwd);
    if (!registered) fail("worktree未在当前Git仓库注册，拒绝按受管目录清理。");
    if (registered.locked) fail("worktree已被Git锁定，拒绝force清理；请人工核查锁原因。");
    if (entries.some(entry => entry.path !== target.cwd && within(target.cwd, entry.path))) fail("worktree包含嵌套注册checkout，拒绝随父目录清理。");
  }

  /** 父tree不覆盖submodule内部未推送历史；.gitmodules与HEAD gitlink取并集，防止配置删除后漏检。 */
  private async assertNoPopulatedSubmodules(target: GitRepository): Promise<void> {
    const paths = new Set<string>(), configured = await git(target.cwd, ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], true, {}, undefined, 15_000, true);
    for (const entry of splitPaths(configured)) {
      const separator = entry.indexOf("\n");
      if (separator < 0) fail("submodule配置无法核验，拒绝清理。");
      paths.add(entry.slice(separator + 1));
    }
    for (const path of await gitTreeGitlinks(target.cwd, "HEAD")) paths.add(path);
    for (const path of paths) {
      assertPath(path);
      let populated = false;
      try { await lstat(join(target.cwd, ...path.split("/"), ".git")); populated = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (populated) fail("worktree包含已初始化submodule，父tree不能证明其内部提交已保存，拒绝清理。");
    }
  }

  /** 核验最终来源的Git父链覆盖每份独立成果，不凭声明推断已集成。 */
  async containsCommit(source: string, ancestor: string): Promise<boolean> {
    assertOid(source); assertOid(ancestor);
    return (await git(this.cwd, ["merge-base", ancestor, source])).trim() === ancestor;
  }

  /** 用临时索引把当前共享worktree的文件收集为一个tree；不改变真实索引或HEAD。 */
  private async worktreeTree(paths: readonly string[]): Promise<string> {
    const temp = await mkdtemp(join(await this.gitDirectory(), "wf-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await git(this.cwd, ["read-tree", "HEAD"], false, env);
      for (const path of paths) await this.assertFilePath(path);
      // 路径已经由tracked diff + exclude-standard untracked核定，-f仅避免新ignore规则拒绝tracked文件。
      if (paths.length) await git(this.cwd, ["--literal-pathspecs", "add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], false, env, paths.join("\0") + "\0");
      const tree = (await git(this.cwd, ["write-tree"], false, env)).trim();
      assertOid(tree);
      // 允许保留仓库原有、未被本次成果修改的 symlink/gitlink；新增或修改这些路径
      // 会在 worktreeTree 的 assertFilePath 阶段拒绝，不能借放宽模式绕过。
      // 完整tree的条目数可能上百万，流式核验，不因输出超过读取上限而拒绝合法证据。
      await assertTreeModes(this.cwd, tree, env);
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

/** 受管 Git 固定参数：禁 hooks、外部 diff/textconv 与签名，固定简洁输出。 */
const GIT_FIXED_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=false", "-c", "commit.gpgSign=false"] as const;
/** 受管 Git 固定环境：无系统/全局配置、无凭据提示，固定作者身份。 */
const GIT_FIXED_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Wave Flow", GIT_AUTHOR_EMAIL: "workspace@wave-flow.local", GIT_COMMITTER_NAME: "Wave Flow", GIT_COMMITTER_EMAIL: "workspace@wave-flow.local" } as const;

/** Git输出始终有界；普通操作默认15秒，创建180秒，删除不中途kill大型checkout。strictUtf8仅用于路径类输出。 */
async function git(cwd: string, args: readonly string[], allowMissing = false, extra: Record<string, string> = {}, input?: string, timeoutMs: number | null = 15_000, strictUtf8 = false): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", ...GIT_FIXED_ARGS, ...args], {
    cwd, env: { ...GIT_FIXED_ENV, ...extra }, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
  try {
    const [out, err, code] = await Promise.all([readBounded(child.stdout, strictUtf8), readBounded(child.stderr), boundedChildExit(child, timeoutMs)]);
    if (code !== 0 && !(allowMissing && code === 1)) throw new GitCommandError(`Git ${args[0]} 失败（${code}）：${err.slice(0, 1000)}`);
    return out;
  } catch (error) { child.kill(); throw error; }
}

/** 需要退出码语义的 Git 调用（merge-base --is-ancestor 等）；其余约定与 git() 相同。 */
async function gitExit(cwd: string, args: readonly string[], timeoutMs: number | null = 15_000): Promise<{ readonly code: number; readonly err: string }> {
  const child = Bun.spawn(["/usr/bin/git", ...GIT_FIXED_ARGS, ...args], { cwd, env: { ...GIT_FIXED_ENV }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [, err, code] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), boundedChildExit(child, timeoutMs)]);
    return { code, err };
  } catch (error) { child.kill(); throw error; }
}

/** 确定性祖先核验：exit 1 是明确“非祖先”结论，属不可重试契约拒绝（WorkflowContractError）；
 * 只有 exit >1 或信号才是可重试的 GitCommandError。避免宿主每次启动重复注定失败的 finalize。 */
async function assertAncestor(cwd: string, ancestor: string, descendant: string, label: string): Promise<void> {
  const { code, err } = await gitExit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (code === 1) fail(`${label}已不是当前 HEAD 的祖先，成果来源链断裂；确定性拒绝交付，不可自动重试。`);
  if (code !== 0) throw new GitCommandError(`Git merge-base 失败（${code}）：${err.slice(0, 1000)}`);
}

/** Git 子进程终止阶梯参数：超时先 SIGTERM，宽限内仍存活升级 SIGKILL，再限时等待退出确认。 */
export const GIT_TERMINATE_GRACE_MS = 2_000;

/** 有界终止阶梯（独立注入点）：timeoutMs 到点 SIGTERM；escalateMs 宽限后升级 SIGKILL；
 * confirmMs 内 exited 仍不 settle 则有界 reject，保证不无限悬挂、不长期持 root 锁。
 * SIGKILL 后正常退出的进程以真实退出码 resolve，由调用方按非零码报错。
 * 自动测试用忽略 SIGTERM 的真实进程验证升级与有界性。 */
export function boundedExit(exited: Promise<number>, kill: (signal: NodeJS.Signals) => void, timeoutMs: number, escalateMs = GIT_TERMINATE_GRACE_MS, confirmMs = GIT_TERMINATE_GRACE_MS): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const term = setTimeout(() => kill("SIGTERM"), timeoutMs);
    const escalate = setTimeout(() => kill("SIGKILL"), timeoutMs + escalateMs);
    const stuck = setTimeout(() => settle(() => reject(new GitCommandError("Git 子进程在 SIGKILL 后仍未确认退出；有界拒绝，避免悬挂持锁。"))), timeoutMs + escalateMs + confirmMs);
    function settle(done: () => void): void { clearTimeout(term); clearTimeout(escalate); clearTimeout(stuck); done(); }
    exited.then(code => settle(() => resolve(code)), error => settle(() => reject(error)));
  });
}

/** 子进程退出等待带终止阶梯；timeoutMs 为 null 表示不中途 kill（如大型 checkout 删除）。 */
function boundedChildExit(child: { readonly exited: Promise<number>; kill: (signal?: number | NodeJS.Signals) => void }, timeoutMs: number | null): Promise<number> {
  if (timeoutMs === null) return child.exited;
  return boundedExit(child.exited, signal => child.kill(signal), timeoutMs);
}

/** 路径类输出必须严格 UTF-8：非法字节序列（非法文件名）明确拒绝且不可重试，
 * 禁止 U+FFFD 替代字符被当作真实路径参与指纹、暂存或删除核验。 */
function decodeStrictUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new WorkflowContractError("Git 路径输出包含非法 UTF-8 字节序列（疑似非法文件名），拒绝按替代字符继续。"); }
}

async function readBounded(stream: ReadableStream<Uint8Array>, strictUtf8 = false): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.length; if (bytes > 2_000_000) { await reader.cancel(); throw new GitEvidenceLimitError("Git 证据超过读取上限，拒绝截断后保存。"); } chunks.push(value.value); } }
  finally { reader.releaseLock(); }
  const bytes_ = Buffer.concat(chunks);
  return strictUtf8 ? decodeStrictUtf8(bytes_) : bytes_.toString("utf8");
}

/** 大列表只参与哈希时的流式读取：内存有界、不截断，哈希覆盖完整字节。 */
async function readIntoDigest(stream: ReadableStream<Uint8Array>, hash: ReturnType<typeof createHash>): Promise<void> {
  const reader = stream.getReader();
  try { while (true) { const value = await reader.read(); if (value.done) break; hash.update(value.value); } }
  finally { reader.releaseLock(); }
}

/** 对只用于指纹的 Git 输出做流式摘要；不把完整输出放进内存，因此大仓库索引不会触发证据上限。 */
async function gitDigest(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", ...GIT_FIXED_ARGS, ...args], { cwd, env: { ...GIT_FIXED_ENV }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const hash = createHash("sha256");
    const [, err, code] = await Promise.all([readIntoDigest(child.stdout, hash), readBounded(child.stderr), boundedChildExit(child, 15_000)]);
    if (code !== 0) throw new GitCommandError(`Git ${args[0]} 失败（${code}）：${err.slice(0, 1000)}`);
    return hash.digest("hex");
  } catch (error) { child.kill(); throw error; }
}

/** 逐条读取 NUL 分隔记录；跨 chunk 不解码半截条目，条目按严格 UTF-8 解码（非法文件名明确拒绝），内存不随完整输出增长。 */
async function readNulEntries(stream: ReadableStream<Uint8Array>, consume: (entry: string) => void): Promise<void> {
  const reader = stream.getReader(); let pending = Buffer.alloc(0);
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      pending = Buffer.concat([pending, Buffer.from(value.value)]);
      let index: number;
      while ((index = pending.indexOf(0)) !== -1) {
        const entry = decodeStrictUtf8(pending.subarray(0, index));
        pending = pending.subarray(index + 1); consume(entry);
      }
    }
  } finally { reader.releaseLock(); }
  if (pending.length) throw new WorkflowContractError("Git NUL 分隔输出未完整读取。");
}

/** 执行 Git 并流式收集 NUL 分隔路径列表：完整无截断（不受 2MiB 证据读取上限约束），
 * 内存只随真实路径列表增长；非法 UTF-8 立即拒绝。用于 inspect/changedBetween 等大列表。 */
async function gitPaths(cwd: string, args: readonly string[], timeoutMs: number | null = 15_000): Promise<string[]> {
  const child = Bun.spawn(["/usr/bin/git", ...GIT_FIXED_ARGS, ...args], { cwd, env: { ...GIT_FIXED_ENV }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const paths: string[] = [];
  try {
    const [, err, code] = await Promise.all([readNulEntries(child.stdout, entry => paths.push(entry)), readBounded(child.stderr), boundedChildExit(child, timeoutMs)]);
    if (code !== 0) throw new GitCommandError(`Git ${args[0]} 失败（${code}）：${err.slice(0, 1000)}`);
    return paths;
  } catch (error) { child.kill(); throw error; }
}

/** 流式核验 tree 条目模式；完整 tree 可能超过内存上限，但不能因此拒绝合法证据。 */
function readTreeModes(stream: ReadableStream<Uint8Array>): Promise<void> {
  return readNulEntries(stream, entry => {
    if (!/^(?:(?:100644|100755|120000) blob |160000 commit )/.test(entry)) throw new WorkflowContractError("候选tree包含不支持的文件模式。");
  });
}

async function assertTreeModes(cwd: string, tree: string, extra: Record<string, string>): Promise<void> {
  const child = Bun.spawn(["/usr/bin/git", ...GIT_FIXED_ARGS, "ls-tree", "-r", "-z", tree], { cwd, env: { ...GIT_FIXED_ENV, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [, err, code] = await Promise.all([readTreeModes(child.stdout), readBounded(child.stderr), boundedChildExit(child, 15_000)]);
    if (code !== 0) throw new GitCommandError(`Git ls-tree 失败（${code}）：${err.slice(0, 1000)}`);
  } catch (error) { child.kill(); throw error; }
}

/** 流式提取HEAD中的gitlink路径；cleanup不把完整tree列表装入内存。 */
async function gitTreeGitlinks(cwd: string, tree: string): Promise<Set<string>> {
  const child = Bun.spawn(["/usr/bin/git", ...GIT_FIXED_ARGS, "ls-tree", "-r", "-z", tree], { cwd, env: { ...GIT_FIXED_ENV }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const paths = new Set<string>();
  try {
    const [, err, code] = await Promise.all([
      readNulEntries(child.stdout, entry => { const match = /^160000 commit [a-f0-9]+\t/.exec(entry); if (match) paths.add(entry.slice(match[0].length)); }),
      readBounded(child.stderr), boundedChildExit(child, 15_000),
    ]);
    if (code !== 0) throw new GitCommandError(`Git ls-tree 失败（${code}）：${err.slice(0, 1000)}`);
    return paths;
  } catch (error) { child.kill(); throw error; }
}

function splitPaths(text: string): string[] { return text.split("\0").filter(Boolean); }
function parseWorktreeList(text: string): { path: string; locked: boolean }[] {
  const entries: { path: string; locked: boolean }[] = [];
  for (const block of text.split("\0\0")) {
    const fields = block.split("\0").filter(Boolean), path = fields.find(field => field.startsWith("worktree "))?.slice(9);
    if (!path) { if (fields.length) fail("Git worktree注册输出无法核验。"); continue; }
    entries.push({ path, locked: fields.some(field => field === "locked" || field.startsWith("locked ")) });
  }
  return entries;
}
function assertOid(oid: string): void { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) fail("必须使用已验证完整 commit oid。"); }
function assertPath(path: string): void { if (!path || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git") || /[\x00-\x1f\x7f\\]/.test(path)) fail("成果路径必须为安全仓库相对文件路径。"); }
function within(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path)); }
function fail(message: string): never { throw new WorkflowContractError(message); }
