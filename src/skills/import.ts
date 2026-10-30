import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readSkillDirectory, readSkillDirectoryByFrontmatter, readSkillLibrary } from "./library";
import type { SkillLibrary, SkillLibraryEntry } from "./types";

/** 可作为导入来源的本机 CLI 技能目录种类。 */
export type SkillSourceCli = "codex" | "claude" | "dsh" | "kimi" | "agents";

/** 一个可导入来源；root 不存在时 exists=false，不视为错误。 */
export type SkillImportSource = {
  /** 来源 CLI 种类；agents 表示共享的 `~/.agents/skills`。 */
  readonly cli: SkillSourceCli;
  /** 面向用户的来源名称。 */
  readonly label: string;
  /** 技能根目录绝对路径。 */
  readonly root: string;
  /** 扫描时该目录是否存在。 */
  readonly exists: boolean;
};

/** 从 CLI 目录发现的一个候选 skill。 */
export type DiscoveredSkill = {
  /** skill 目录名（kebab-case）。 */
  readonly name: string;
  /** frontmatter description；非法时为原始目录名说明。 */
  readonly description: string;
  /** 来源 CLI 种类。 */
  readonly sourceCli: SkillSourceCli;
  /** 来源展示名称。 */
  readonly sourceLabel: string;
  /** skill 目录 canonical 绝对路径，用于导入时定位。 */
  readonly path: string;
  /** SKILL.md 的 SHA-256；非法候选为 null。 */
  readonly skillMdSha256: string | null;
  /**
   * 与托管库的同名关系：none 未安装；same 表示 SKILL.md 摘要一致；different 表示不同。
   * 资源文件不参与该判定，UI 不得把 same 展示成整个目录完全一致。
   */
  readonly installed: "none" | "same" | "different";
  /** 是否通过静态校验。 */
  readonly valid: boolean;
  /** 校验失败原因；valid=true 时为 null。 */
  readonly issue: string | null;
};

/** 技能导入发现结果。 */
export type SkillDiscoverResult = {
  /** 所有扫描过的来源，含缺失的空来源。 */
  readonly sources: readonly SkillImportSource[];
  /** 有效或可解释的候选 skill。 */
  readonly skills: readonly DiscoveredSkill[];
};

/** 单个 ZIP 的大小与条目护栏；避免压缩炸弹在展开后才被发现。 */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;

/** 返回本机 CLI 技能来源；home 可注入用于测试。 */
export function skillImportSources(home: string = homedir()): readonly { readonly cli: SkillSourceCli; readonly label: string; readonly root: string }[] {
  return [
    { cli: "codex", label: "Codex CLI", root: join(home, ".codex", "skills") },
    { cli: "claude", label: "Claude Code", root: join(home, ".claude", "skills") },
    { cli: "dsh", label: "DeepSeek Harness", root: join(home, ".dsh", "skills") },
    { cli: "kimi", label: "Kimi Code（应用内暂停）", root: join(home, ".kimi-code", "skills") },
    { cli: "agents", label: "共享 agents", root: join(home, ".agents", "skills") },
  ];
}

/**
 * 扫描各 CLI 原生技能目录，返回可导入候选。
 *
 * 只读；不跟随来源根软链，不读取 SKILL.md 以外的资源；非法候选保留原因供 UI 展示。
 */
export async function discoverSkills(libraryRoot: string, home: string = homedir()): Promise<SkillDiscoverResult> {
  const library = await readSkillLibrary(libraryRoot);
  return discoverSkillsInLibrary(library, home);
}

/** 与 discoverSkills 相同，但复用已扫描的库摘要，供 Engine 一次 action 内调用。 */
export async function discoverSkillsInLibrary(library: SkillLibrary, home: string = homedir()): Promise<SkillDiscoverResult> {
  const installed = new Map(library.skills.map(skill => [skill.name, skill]));
  const sources: SkillImportSource[] = [];
  const skills: DiscoveredSkill[] = [];
  const seenPaths = new Set<string>();
  for (const source of skillImportSources(home)) {
    let info;
    try { info = await lstat(source.root); }
    catch { sources.push({ ...source, exists: false }); continue; }
    if (info.isSymbolicLink() || !info.isDirectory()) { sources.push({ ...source, exists: false }); continue; }
    sources.push({ ...source, exists: true });
    const entries = await readdir(source.root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const directory = join(source.root, entry.name);
      let canonical: string;
      try {
        canonical = await realpath(directory);
        if (!(await lstat(canonical)).isDirectory()) continue;
      } catch { continue; }
      if (seenPaths.has(canonical)) continue;
      seenPaths.add(canonical);
      const existing = installed.get(entry.name);
      try {
        // 原生 CLI 常用 symlink 管理 skill；显示/导入使用 frontmatter 的稳定 name，
        // path 保留来源根下的词法路径，供导入时继续做来源白名单校验。
        const checked = entry.isSymbolicLink() ? await readSkillDirectoryByFrontmatter(canonical) : await readSkillDirectory(directory);
        const installedEntry = installed.get(checked.name) ?? existing;
        skills.push({
          name: checked.name,
          description: checked.description,
          sourceCli: source.cli,
          sourceLabel: source.label,
          path: directory,
          skillMdSha256: checked.skillMdSha256,
          installed: installedEntry ? (installedEntry.skillMdSha256 === checked.skillMdSha256 ? "same" : "different") : "none",
          valid: true,
          issue: null,
        });
      } catch (error) {
        skills.push({
          name: entry.name,
          description: "",
          sourceCli: source.cli,
          sourceLabel: source.label,
          path: canonical,
          skillMdSha256: null,
          installed: existing ? "different" : "none",
          valid: false,
          issue: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { sources, skills };
}

/**
 * 把指定 CLI 技能目录复制进托管库。
 *
 * 只允许来源直接位于已知 CLI 技能根下；先校验再复制，复制后再次校验；同名目标存在时拒绝，
 * 不覆盖用户已有 skill。返回最终校验通过的条目。
 */
export async function importSkillFromDirectory(sourcePath: string, libraryRoot: string, home: string = homedir()): Promise<SkillLibraryEntry> {
  const lexical = resolve(sourcePath);
  const info = await lstat(lexical);
  const real = await realpath(lexical);
  const sources = skillImportSources(home);
  let allowed = false;
  for (const source of sources) {
    // 白名单校验来源根下的词法路径；symlink 目标可以在根外，但仍必须通过同一套 skill 校验。
    if (dirname(lexical) === resolve(source.root)) { allowed = true; break; }
  }
  if (!allowed) throw new Error("只能从已识别的本机 CLI 技能目录导入 skill；ZIP 请使用压缩包导入。");
  const checked = info.isSymbolicLink() ? await readSkillDirectoryByFrontmatter(real) : await readSkillDirectory(real);
  return await copyIntoLibrary(real, libraryRoot, checked.name);
}

/**
 * 从 skill.zip 导入单个 skill。
 *
 * 支持两种布局：ZIP 根直接含 SKILL.md，或恰好一个顶层目录含 SKILL.md。
 * 展开前校验条目路径、数量与总解压大小；展开后由技能库同一套校验拒绝软链/非法文件。
 */
export async function importSkillZip(zipPath: string, libraryRoot: string): Promise<SkillLibraryEntry> {
  if (!isAbsolute(zipPath)) throw new Error("skill.zip 路径必须是绝对路径。");
  const info = await lstat(zipPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("skill.zip 必须是常规文件。");
  if (!zipPath.toLowerCase().endsWith(".zip")) throw new Error("只支持 .zip 格式的 skill 压缩包。");
  if (info.size > MAX_ZIP_BYTES) throw new Error("skill.zip 超过 50MiB 上限。");
  const entries = listZipEntries(zipPath);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`skill.zip 条目超过 ${MAX_ZIP_ENTRIES} 个上限。`);
  for (const entry of entries) assertZipEntry(entry);
  if (zipUncompressedBytes(zipPath) > MAX_ZIP_BYTES) throw new Error("skill.zip 解压后超过 50MiB 上限。");
  const scratch = await mkdtemp(join(tmpdir(), "wave-flow-skill-zip-"));
  try {
    const extracted = runSystemUnzip(["-q", "-o", zipPath, "-d", scratch]);
    if (extracted.exitCode !== 0) throw new Error(`skill.zip 解压失败：${extracted.stderr.toString().trim().slice(0, 200) || "未知错误"}`);
    const root = await locateZipSkillRoot(scratch);
    // 根目录布局没有稳定 basename，skill 身份由 frontmatter.name 决定。
    const checked = root === scratch ? await readSkillDirectoryByFrontmatter(root) : await readSkillDirectory(root);
    return await copyIntoLibrary(root, libraryRoot, checked.name);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** 把已验证的 skill 目录复制进库；先在临时目录按正确名字校验，再原子 rename。返回库内最终条目。 */
async function copyIntoLibrary(source: string, libraryRoot: string, name: string): Promise<SkillLibraryEntry> {
  await mkdir(libraryRoot, { recursive: true, mode: 0o700 });
  const destination = join(libraryRoot, name);
  if (await exists(destination)) throw new Error(`技能库已存在同名 skill：${name}。请先在文件系统中处理旧版本。`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wave-flow-skill-import-"));
  const checked = join(temporaryRoot, name);
  const staging = join(libraryRoot, `.import-${crypto.randomUUID()}`);
  try {
    await cp(source, checked, { recursive: true, errorOnExist: true });
    await readSkillDirectory(checked);
    await cp(checked, staging, { recursive: true, errorOnExist: true });
    await rename(staging, destination);
    return await readSkillDirectory(destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    // 并发导入同名 skill 时，后到的 rename 可能报 ENOTEMPTY；保持“同名拒绝”语义并给出可操作原因。
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOTEMPTY") {
      throw new Error(`技能库已存在同名 skill：${name}。请先在文件系统中处理旧版本。`);
    }
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function listZipEntries(zipPath: string): string[] {
  const listed = runSystemUnzip(["-Z1", zipPath]);
  if (listed.exitCode !== 0) throw new Error(`无法读取 skill.zip：${listed.stderr.toString().trim().slice(0, 200) || "未知错误"}`);
  return listed.stdout.toString().split("\n").map(line => line.trim()).filter(Boolean);
}

/**
 * 系统自带解压器：固定 `/usr/bin/unzip`，不从 PATH 猜、不随包分发。
 *
 * macOS 自带该工具；缺失（极少数精简环境）时给出可操作诊断，而不是让 spawn 抛出底层错误。
 * 解压前的路径/大小护栏仍以解压器列出的条目为准。
 */
const SYSTEM_UNZIP = "/usr/bin/unzip";

function runSystemUnzip(args: readonly string[]): Bun.SyncSubprocess<"pipe", "pipe"> {
  if (!existsSync(SYSTEM_UNZIP)) throw new Error("导入 .zip 需要系统 unzip（/usr/bin/unzip），但本机不可用；请先解压，再导入 skill 目录。");
  return Bun.spawnSync([SYSTEM_UNZIP, ...args], { stdout: "pipe", stderr: "pipe" });
}

/** 拒绝绝对路径、`..` 穿越、反斜杠与空路径段；允许目录项以 / 结尾。 */
function assertZipEntry(entry: string): void {
  if (entry.includes("\\") || entry.includes("\0")) throw new Error(`skill.zip 包含非法路径：${entry.slice(0, 120)}`);
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) throw new Error(`skill.zip 不允许绝对路径：${entry.slice(0, 120)}`);
  const parts = entry.split("/").filter(part => part.length > 0);
  if (parts.length === 0 || parts.some(part => part === ".." || part === ".")) throw new Error(`skill.zip 包含路径穿越：${entry.slice(0, 120)}`);
}

function zipUncompressedBytes(zipPath: string): number {
  const listed = runSystemUnzip(["-l", zipPath]);
  if (listed.exitCode !== 0) throw new Error("无法读取 skill.zip 大小。");
  let total = 0;
  for (const line of listed.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (match) total += Number(match[1]);
  }
  return total;
}

/** 定位 ZIP 中唯一的 skill 根；根含 SKILL.md，或恰好一个顶层目录含 SKILL.md。 */
async function locateZipSkillRoot(scratch: string): Promise<string> {
  if (await exists(join(scratch, "SKILL.md"))) return scratch;
  const top = (await readdir(scratch, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "__MACOSX");
  if (top.length !== 1) throw new Error("skill.zip 必须只包含一个 skill（根目录 SKILL.md 或唯一顶层 skill 目录）。");
  const root = join(scratch, top[0]!.name);
  if (!await exists(join(root, "SKILL.md"))) throw new Error("skill.zip 中找不到 SKILL.md。");
  return root;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}
