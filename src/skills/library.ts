import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { waveFlowHome } from "../journal/paths";
import type { SkillLibrary, SkillLibraryEntry, SkillLibraryInvalidEntry } from "./types";

/** 技能库静态校验失败；issues 逐条可展示，不包含凭据或完整环境。 */
export class SkillLibraryValidationError extends Error {
  /** 每个违规项一行，包含相对库根的定位与可操作原因。 */
  readonly issues: readonly string[];

  constructor(root: string, issues: readonly string[]) {
    super(`技能库校验失败（${root}）：${issues.slice(0, 12).join("；")}${issues.length > 12 ? `；另有 ${issues.length - 12} 项` : ""} `);
    this.name = "SkillLibraryValidationError";
    this.issues = issues;
  }
}

/** 技能库根目录；默认 `waveFlowHome()/skills`，测试与隔离运行可显式注入。 */
export function skillLibraryRoot(stateRoot: string = waveFlowHome()): string {
  return join(stateRoot, "skills");
}

/**
 * 只读扫描并校验托管技能库。
 *
 * 语义：库不存在/为空是合法空状态；单个不合法 skill 进入 invalid 并被跳过，其他合法
 * skill 继续可用，设置页必须展示 invalid 诊断。根目录软链/非目录等库级错误才整次失败。
 * 不写入磁盘、不启动进程、不读取 skill 正文以外的资源。
 */
export async function readSkillLibrary(root: string = skillLibraryRoot()): Promise<SkillLibrary> {
  let info;
  try { info = await lstat(root); }
  catch (error) {
    if (isMissing(error)) return { root, exists: false, digest: null, skills: [] };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new SkillLibraryValidationError(root, ["技能库根必须是常规目录，不能是软链或文件。"]);
  const entries = await readdir(root, { withFileTypes: true });
  const invalid: SkillLibraryInvalidEntry[] = [];
  const skills: SkillLibraryEntry[] = [];
  const names = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) { invalid.push({ name: entry.name, issue: "skill 目录不能是软链。" }); continue; }
    if (!entry.isDirectory()) continue; // 顶层普通文件（README 等）不是 skill，忽略。
    const name = entry.name;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { invalid.push({ name, issue: "目录名必须是 kebab-case。" }); continue; }
    if (names.has(name)) { invalid.push({ name, issue: "skill 名称重复。" }); continue; }
    const directory = join(root, name);
    try {
      const skill = await readSkill(directory, name);
      names.add(name);
      skills.push(skill);
    } catch (error) {
      invalid.push({ name, issue: error instanceof Error ? error.message : String(error) });
    }
  }
  const digest = skills.length === 0 ? null : createHash("sha256").update(skills.map(skill => `${skill.name}\0${skill.skillMdSha256}\n`).join("")).digest("hex");
  return { root, exists: true, digest, skills, ...(invalid.length > 0 ? { invalid } : {}) };
}

/**
 * 校验并读取单个 skill 目录；用于导入前验证，不要求它位于库根下。
 *
 * 名字取目录 basename，规则与库扫描一致；失败时抛出可直接展示的原因。
 */
export async function readSkillDirectory(directory: string): Promise<SkillLibraryEntry> {
  const name = basename(directory);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`目录名 ${name} 必须是 kebab-case。`);
  return readSkill(directory, name);
}

/**
 * 校验 ZIP 根目录布局：此时目录 basename 是临时随机名，身份只能来自 frontmatter.name。
 * 仍要求 frontmatter.name 是 kebab-case，并复用同一套 SKILL.md/软链/资源校验。
 */
export async function readSkillDirectoryByFrontmatter(directory: string): Promise<SkillLibraryEntry> {
  return readSkill(directory, null);
}

/** 计算库摘要；非法库直接抛出同一校验错误，供 Replay 前的保守判定使用。 */
export async function readSkillLibraryDigest(root: string = skillLibraryRoot()): Promise<string | null> {
  return (await readSkillLibrary(root)).digest;
}

async function readSkill(directory: string, expectedName: string | null): Promise<SkillLibraryEntry> {
  const skillFile = join(directory, "SKILL.md");
  let fileInfo;
  try { fileInfo = await lstat(skillFile); }
  catch (error) { if (isMissing(error)) throw new Error("缺少 SKILL.md。"); throw error; }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error("SKILL.md 必须是常规文件，不能是软链或目录。");
  if (fileInfo.size > 512 * 1024) throw new Error("SKILL.md 超过 512KiB 上限。");
  const bytes = await readFile(skillFile);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("SKILL.md 不是合法 UTF-8。"); }
  const frontmatter = parseFrontmatter(text);
  const name = expectedName ?? frontmatter.name;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`frontmatter name（${frontmatter.name || "缺失"}）必须是 kebab-case。`);
  if (frontmatter.name !== name) throw new Error(`frontmatter name（${frontmatter.name || "缺失"}）必须与目录名一致。`);
  if (!frontmatter.description) throw new Error("frontmatter description 必须为非空单行说明。");
  await assertRegularTree(name, directory);
  return { name, path: directory, description: frontmatter.description, skillMdSha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, requiredBins: frontmatter.requiredBins };
}

/** 拒绝 skill 目录内的软链与特殊文件；限制扫描条目数，避免超大目录阻塞会话启动。 */
async function assertRegularTree(name: string, directory: string): Promise<void> {
  const pending = [directory];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 5000) throw new Error("skill 目录条目超过 5000 个上限。");
      if (entry.isSymbolicLink()) throw new Error(`${entry.name}：skill 内不允许软链。`);
      if (entry.isDirectory()) { pending.push(join(current, entry.name)); continue; }
      if (!entry.isFile()) throw new Error(`${entry.name}：skill 内只允许常规文件与目录。`);
    }
  }
}

/**
 * 最小 YAML frontmatter 读取：只解析顶层标量键，嵌套结构与未知字段原样忽略。
 *
 * 这不是完整 YAML 解析器；职责是提取 name/description 并拒绝明显非法的顶层写法，
 * 真正的 CLI 可能更严格，投影证据必须如实记录而不是宣称已跨 CLI 验证。
 */
function parseFrontmatter(text: string): { name: string; description: string; requiredBins: readonly string[] } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error("缺少以 --- 包裹的 YAML frontmatter。");
  const values = new Map<string, string>();
  const lines = match[1]!.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^[\s-]/.test(line)) continue; // 嵌套列表/对象由 CLI 负责，本层不解释。
    const keyValue = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (!keyValue) throw new Error(`frontmatter 顶层无法解析：${line.slice(0, 80)}`);
    const key = keyValue[1]!;
    const rawValue = (keyValue[2] ?? "").trim();
    const block = /^([>|])([+-])?$/.exec(rawValue);
    let value: string;
    if (block) {
      if (key !== "description") throw new Error(`frontmatter 的 ${key} 必须是单行标量。`);
      const collected: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]!;
        if (!next.trim()) { collected.push(""); continue; }
        const indent = next.length - next.trimStart().length;
        if (indent === 0) break;
        collected.push(next.trim());
      }
      index = cursor - 1;
      value = block[1] === ">" ? collected.filter(item => item.length > 0).join(" ") : collected.join("\n").trim();
    } else value = scalar(rawValue);
    if (values.has(key)) throw new Error(`frontmatter 顶层字段重复：${key}`);
    values.set(key, value);
  }
  return { name: values.get("name") ?? "", description: values.get("description") ?? "", requiredBins: parseRequiredBins(lines) };
}

/**
 * 只读解析 `metadata.requires.bins`，支持内联数组与块列表两种常见写法。
 *
 * 这是诊断用的最小解析，不是完整 YAML；其他 metadata 字段保持不解释。
 * 声明了 bins 但无法解析时整库 fail closed，避免把缺失依赖误报成“已检查”。
 */
function parseRequiredBins(lines: readonly string[]): readonly string[] {
  let metadataIndent: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.length - line.trimStart().length;
    if (metadataIndent === null) {
      if (indent === 0 && /^metadata:\s*(?:#.*)?$/.test(trimmed)) metadataIndent = indent;
      continue;
    }
    if (indent <= metadataIndent) break;
    if (!/^requires:\s*(?:#.*)?$/.test(trimmed)) continue;
    const requiresIndent = indent;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!;
      const candidateTrimmed = candidate.trim();
      if (!candidateTrimmed) continue;
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidateIndent <= requiresIndent) break;
      const bins = /^bins:\s*(.*)$/.exec(candidateTrimmed);
      if (!bins) continue;
      const inline = bins[1]!.replace(/\s+#.*$/, "").trim();
      if (inline) return parseInlineSequence(inline);
      const values: string[] = [];
      for (let itemCursor = cursor + 1; itemCursor < lines.length; itemCursor += 1) {
        const itemLine = lines[itemCursor]!;
        const itemTrimmed = itemLine.trim();
        if (!itemTrimmed) continue;
        const itemIndent = itemLine.length - itemLine.trimStart().length;
        if (itemIndent <= candidateIndent) break;
        const item = /^-\s+(.*)$/.exec(itemTrimmed);
        if (!item) throw new Error(`metadata.requires.bins 列表项无法解析：${itemTrimmed.slice(0, 80)}`);
        const value = scalar(item[1]!);
        if (!value) throw new Error("metadata.requires.bins 列表项不能为空。");
        values.push(value);
      }
      return [...new Set(values)];
    }
  }
  return [];
}

/** 解析 `[ "a", 'b' ]` 形式的最小内联数组；不做完整 YAML 流式语法。 */
function parseInlineSequence(value: string): readonly string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("metadata.requires.bins 必须是数组。");
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === ",") { if (current.trim()) items.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (quote) throw new Error("metadata.requires.bins 字符串未闭合。");
  if (current.trim()) items.push(current.trim());
  return [...new Set(items)];
}

/** 只接受单行标量；`|`/`>` 折叠语法明确拒绝，避免把多行内容误当单行说明。 */
function scalar(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value === "|" || value === ">" || value === "|-" || value === ">-") throw new Error("frontmatter 的 name/description 必须是单行标量。");
  if (value.startsWith("\"")) {
    if (!value.endsWith("\"") || value.length < 2) throw new Error("frontmatter 双引号字符串未闭合。");
    return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error("frontmatter 单引号字符串未闭合。");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
