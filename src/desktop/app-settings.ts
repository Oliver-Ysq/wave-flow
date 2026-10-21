import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";

/**
 * 桌面应用级设置；只保存用户显式选择，不保存凭据、路径或环境变量。
 * 该类型同时是 Engine action `settings.get/update` 的返回契约。
 */
export type AppSettings = {
  /**
   * 感知模式：为 true 时主控会话使用用户原生 CLI 配置与工具，可通过本机
   * skill/MCP/CLI 读取项目、本机与外部信息；默认 true。关闭后回落到私有 Home、
   * 全量写隔离与只注入四个控制工具的旧会话模型。
   */
  readonly perceptionMode: boolean;
};

/** 设置文件缺失时使用的默认值；感知模式默认开启，用户可在设置中关闭。 */
export const DEFAULT_APP_SETTINGS: AppSettings = { perceptionMode: true };

/**
 * 用户级设置存储。写入串行化并原子替换；文件损坏时抛错而不是静默回退，
 * 避免用户以为关掉了感知模式但实际仍以默认值运行。
 */
export class AppSettingsStore {
  /** 读-改-写串行链；Engine 的 action 并发派发，不能依赖调用顺序。 */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly root = waveFlowHome()) {}

  /** 读取当前设置；文件不存在返回默认值，内容非法抛错。 */
  async get(): Promise<AppSettings> {
    let text: string;
    try {
      text = await readFile(this.path(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_APP_SETTINGS;
      throw new Error(`读取设置失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("设置文件不是合法 JSON；请修正或删除后重试。 ");
    }
    return parseSettings(parsed);
  }

  /** 合并写入设置；只接受已知字段与布尔值，未知字段拒绝。 */
  async update(patch: unknown): Promise<AppSettings> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置更新必须是对象。 ");
    const record = patch as Record<string, unknown>;
    for (const key of Object.keys(record)) if (key !== "perceptionMode") throw new Error(`未知设置项：${key}`);
    if (record.perceptionMode !== undefined && typeof record.perceptionMode !== "boolean") throw new Error("感知模式必须是布尔值。 ");
    const run = this.#writes.then(async () => {
      const current = await this.get();
      const next: AppSettings = {
        perceptionMode: record.perceptionMode === undefined ? current.perceptionMode : record.perceptionMode as boolean,
      };
      await this.write(next);
      return next;
    });
    this.#writes = run.then(() => {}, () => {});
    return run;
  }

  /** 设置文件路径；root 由构造器注入，生产为 waveFlowHome()。 */
  private path(): string { return join(this.root, "settings.json"); }

  /** 原子替换：同目录临时文件写完并 fsync 后 rename，权限固定为当前用户私有。 */
  private async write(value: AppSettings): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.settings-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "w", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.path());
  }
}

/** 严格解析设置文件；未知字段同样拒绝，避免拼写错误被静默忽略。 */
function parseSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("设置文件必须是 JSON 对象。 ");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== "perceptionMode") throw new Error(`设置文件包含未知字段：${key}`);
  if (record.perceptionMode !== undefined && typeof record.perceptionMode !== "boolean") throw new Error("设置文件中的感知模式必须是布尔值。 ");
  return { perceptionMode: record.perceptionMode === undefined ? DEFAULT_APP_SETTINGS.perceptionMode : record.perceptionMode };
}
