import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { realpath } from "node:fs/promises";
import { waveFlowHome } from "../journal/paths";

/** 用户侧边栏中的耐久项目，不等同于 Workflow Run 或 Harness 会话。 */
export type HarnessProject = {
  /** 稳定项目 UUID；会话只引用此 id，不用 cwd 推断归属。 */
  readonly projectId: string;
  /** realpath 后的项目目录；新会话仅能从此目录继承 cwd。 */
  readonly cwd: string;
  /** 侧边栏显示名称；默认取目录名。 */
  readonly title: string;
  /** 项目首次登记时间。 */
  readonly createdAt: string;
  /** 最近创建会话或显式打开项目的时间。 */
  readonly updatedAt: string;
};

/** 项目目录列表的私有 Store；不扫描磁盘，也不从 Harness cwd 反推项目。 */
export class HarnessProjectStore {
  constructor(private readonly root = waveFlowHome()) {}
  async list(): Promise<readonly HarnessProject[]> {
    const value = await this.read();
    return [...value].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  /** 路径 realpath 后按 cwd 去重；同一目录不会产生两个项目实体。 */
  async create(cwd: string, title?: string): Promise<HarnessProject> {
    const resolved = await realpath(cwd).catch(() => { throw new Error("项目路径不可验证。 "); });
    const projects = await this.read();
    const existing = projects.find((project) => project.cwd === resolved);
    if (existing) return existing;
    const now = new Date().toISOString();
    const project: HarnessProject = { projectId: crypto.randomUUID(), cwd: resolved, title: normalizeTitle(title, resolved), createdAt: now, updatedAt: now };
    await this.write([...projects, project]);
    return project;
  }
  async get(projectId: string): Promise<HarnessProject> {
    const project = (await this.read()).find((item) => item.projectId === projectId);
    if (!project) throw new Error("未知项目。 ");
    return project;
  }
  async touch(projectId: string): Promise<HarnessProject> {
    const projects = await this.read();
    const index = projects.findIndex((item) => item.projectId === projectId);
    if (index < 0) throw new Error("未知项目。 ");
    const project = { ...projects[index], updatedAt: new Date().toISOString() };
    projects[index] = project;
    await this.write(projects);
    return project;
  }
  private path(): string { return join(this.root, "projects.json"); }
  private async read(): Promise<HarnessProject[]> {
    try { await assertPrivateDirectory(this.root); } catch (error) { if (isMissing(error)) return []; throw error; }
    try { const path = this.path(); await assertPrivateFile(path); return validateProjects(JSON.parse(await readFile(path, "utf8"))); } catch (error) { if (isMissing(error)) return []; throw new Error(`项目列表不可读取：${error instanceof Error ? error.message : String(error)}`); }
  }
  private async write(projects: readonly HarnessProject[]): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => {});
    const destination = this.path(); const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(projects, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination); await chmod(destination, 0o600);
  }
}

function normalizeTitle(title: string | undefined, cwd: string): string { const value = title?.trim() || basename(cwd); if (!value || value.length > 120 || /[\r\n]/.test(value)) throw new Error("项目名称必须是 1-120 个单行字符。 "); return value; }
function validateProjects(value: unknown): HarnessProject[] {
  if (!Array.isArray(value)) throw new Error("项目列表格式无效。 ");
  const ids = new Set<string>(); const paths = new Set<string>();
  return value.map((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("项目记录无效。 "); const project = item as HarnessProject; if (typeof project.projectId !== "string" || !project.projectId || typeof project.cwd !== "string" || !project.cwd.startsWith("/") || typeof project.title !== "string" || !project.title || typeof project.createdAt !== "string" || typeof project.updatedAt !== "string" || Number.isNaN(Date.parse(project.createdAt)) || Number.isNaN(Date.parse(project.updatedAt)) || ids.has(project.projectId) || paths.has(project.cwd)) throw new Error("项目记录无效。 "); ids.add(project.projectId); paths.add(project.cwd); return project; });
}
async function assertPrivateDirectory(path: string): Promise<void> { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("项目状态目录不安全。 "); }
async function assertPrivateFile(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("项目状态文件不安全。 "); }
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
