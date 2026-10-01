import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JournalRecord, JournalSummary, RunManifest } from "./types";

/** 同一 run 的 append-only Journal；负责串行落盘和 completed 节点索引。 */
export class RunJournal {
  readonly #completed = new Map<string, Extract<JournalRecord, { event: "agent.completed" }>>();
  #appendQueue: Promise<void> = Promise.resolve();
  #summary: JournalSummary = { completed: 0, started: 0, failed: 0, replayed: 0 };

  private constructor(
    readonly manifest: RunManifest,
    readonly directory: string,
  ) {}

  /** @param manifest 新 run 的固定身份。@param root 状态根目录，默认当前项目 .wave-flow/runs。 */
  static async create(manifest: RunManifest, root: string): Promise<RunJournal> {
    validateManifest(manifest, manifest.runId, root);
    const directory = resolveRunDirectory(root, manifest.runId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(directory, "journal.jsonl"), "", "utf8");
    return new RunJournal(manifest, directory);
  }

  /** @param runId 要恢复的 run。@param root 状态根目录。@throws manifest 或 journal 不存在/损坏时抛出。 */
  static async open(runId: string, root: string): Promise<RunJournal> {
    const directory = resolveRunDirectory(root, runId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown;
    } catch (error) {
      throw new Error(`无法读取 run manifest：${error instanceof Error ? error.message : String(error)}`);
    }
    const manifest = validateManifest(parsed, runId, root);
    const journal = new RunJournal(manifest, directory);
    const text = await readFile(join(directory, "journal.jsonl"), "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as JournalRecord;
        journal.#index(record);
      } catch (error) {
        // append-only JSONL 在进程被杀死时可能留下唯一的截断尾行；此前的完整节点仍可安全回放。
        const hasLaterRecord = lines.slice(index + 1).some((later) => later.trim() !== "");
        if (hasLaterRecord) {
          throw new Error(`Journal 已损坏：第 ${index + 1} 行无法解析。`);
        }
      }
    }
    return journal;
  }

  /** 取得同一 run 内完全匹配的完成节点；started/failed 永远不能回放。 */
  completed(nodeKey: string, inputHash: string): unknown | undefined {
    const record = this.#completed.get(nodeKey);
    return record?.inputHash === inputHash ? record.output : undefined;
  }

  /** 追加一条节点事实；并发 Agent 的写入通过队列保持一行一个完整 JSON。 */
  async append(record: JournalRecord): Promise<void> {
    this.#appendQueue = this.#appendQueue.then(async () => {
      await appendFile(join(this.directory, "journal.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
      this.#index(record);
    });
    return this.#appendQueue;
  }

  /** 已回放节点只记入内存统计，不重复写 completed 记录。 */
  markReplayed(): void {
    this.#summary.replayed += 1;
  }

  /** 等待全部排队写入完成；Runner 在返回或抛错前调用它。 */
  async flush(): Promise<void> {
    await this.#appendQueue;
  }

  /** @returns inspect 所需的紧凑状态。 */
  summary(): JournalSummary {
    return { ...this.#summary };
  }

  #index(record: JournalRecord): void {
    if (record.event === "agent.completed") {
      this.#completed.set(record.nodeKey, record);
      this.#summary.completed += 1;
    } else if (record.event === "agent.started") {
      this.#summary.started += 1;
    } else {
      this.#summary.failed += 1;
      this.#summary.latestError = record.error;
    }
  }
}

/** 仅接受本 Runtime 生成的 UUID runId，阻止 join(root, runId) 的路径穿越。 */
export function validateRunId(runId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error("无效的 runId：必须是 wave-flow 创建的 UUID。");
  }
}

/** 将 runId 解析到 runs 根目录内，并额外验证 resolved path 没有逃逸。 */
export function resolveRunDirectory(root: string, runId: string): string {
  validateRunId(runId);
  const resolvedRoot = resolve(root);
  const directory = resolve(resolvedRoot, runId);
  const pathFromRoot = relative(resolvedRoot, directory);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("无效的 runId：run 目录超出状态根目录。");
  }
  return directory;
}

/**
 * 对落盘 manifest 做运行时验证。TypeScript assertion 不能信任用户可修改的 JSON 文件。
 * @param value manifest 的未知 JSON 值。
 * @param requestedRunId CLI 用户请求的 runId，必须与 manifest 一致。
 * @returns 已验证的 RunManifest。
 */
export function validateManifest(value: unknown, requestedRunId: string, runsRoot: string): RunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的 run manifest：必须是对象。");
  const manifest = value as Record<string, unknown>;
  validateRunId(requestedRunId);
  if (manifest.runId !== requestedRunId) throw new Error("无效的 run manifest：runId 与请求不一致。");
  if (typeof manifest.workflowPath !== "string" || !isAbsolute(manifest.workflowPath)) throw new Error("无效的 run manifest：workflowPath 必须是绝对路径。");
  if (typeof manifest.cwd !== "string" || !isAbsolute(manifest.cwd)) throw new Error("无效的 run manifest：cwd 必须是绝对路径。");
  const projectRoot = resolve(runsRoot, "..", "..");
  if (!isPathWithin(projectRoot, manifest.workflowPath)) throw new Error("无效的 run manifest：workflowPath 必须位于当前项目内。");
  if (!isPathWithin(projectRoot, manifest.cwd)) throw new Error("无效的 run manifest：cwd 必须位于当前项目内。");
  if (typeof manifest.workflowHash !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.workflowHash)) throw new Error("无效的 run manifest：workflowHash 格式错误。");
  if (manifest.adapter !== "fake" && manifest.adapter !== "codex") throw new Error("无效的 run manifest：adapter 不受支持。");
  if (!manifest.input || typeof manifest.input !== "object" || Array.isArray(manifest.input)) throw new Error("无效的 run manifest：input 必须是 JSON 对象。");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error("无效的 run manifest：createdAt 格式错误。");
  return manifest as unknown as RunManifest;
}

/** @returns path 是否位于 projectRoot 本身或其子目录，避免 manifest 引导 resume 访问项目外路径。 */
function isPathWithin(projectRoot: string, path: string): boolean {
  const relativePath = relative(projectRoot, resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** @param root 项目根目录。@returns run 状态目录。 */
export function runsDirectory(root: string): string {
  return join(root, ".wave-flow", "runs");
}

/** @param filePath 用于确保 manifest 所在目录可写的辅助函数。 */
export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
