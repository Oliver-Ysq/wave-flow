import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject } from "../shared/json";
import { nodeDirectoryName, runDirectory, validateRunId } from "./paths";
import type { JournalEvent, RunManifest } from "./types";
import { RunStateMachine } from "../runtime/run-state-machine";

/** 同一 Run 的 append-only Journal 与结果文件存储；不解释节点状态机。 */
export class RunJournal {
  #appendQueue: Promise<void> = Promise.resolve();

  private constructor(readonly manifest: RunManifest, readonly directory: string) {}

  /** 仅供故障注入测试使用：下一次追加操作失败，验证 Runtime 不会把失败吞掉。 */
  failNextAppendForTest(message = "Injected Journal append failure"): void {
    this.#appendQueue = Promise.reject(new Error(message));
    void this.#appendQueue.catch(() => undefined);
  }

  /** 创建空 Journal，并先耐久写入 Manifest 与 run.created 事实。 */
  static async create(manifest: RunManifest, root: string): Promise<RunJournal> {
    validateManifest(manifest);
    const directory = runDirectory(root, manifest.runId);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "journal.jsonl"), "", "utf8");
    const journal = new RunJournal(manifest, directory);
    await journal.append({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    return journal;
  }

  /** 打开已存在 Run，返回 Manifest 与全部有效 Journal 事实；中间损坏必须拒绝。 */
  static async open(runId: string, root: string): Promise<{ journal: RunJournal; events: readonly JournalEvent[] }> {
    validateRunId(runId);
    const directory = runDirectory(root, runId);
    const manifest = validateManifest(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown);
    if (manifest.runId !== runId) throw new Error("Manifest runId 与请求不一致。");
    const text = await readFile(join(directory, "journal.jsonl"), "utf8");
    const lines = text.split("\n");
    const events: JournalEvent[] = [];
    const state = new RunStateMachine(manifest);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]) as unknown;
      } catch (error) {
        const hasLaterLine = lines.slice(index + 1).some((line) => line.trim());
        if (hasLaterLine || !isTruncatedJsonTail(lines[index])) throw new Error(`Journal 第 ${index + 1} 行损坏：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      try {
        const event = validateEvent(parsed, manifest.runId);
        if (event.type === "agent.completed") await validateCompletedResult(directory, event);
        state.apply(event);
        events.push(event);
      } catch (error) {
        throw new Error(`Journal 第 ${index + 1} 行损坏：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { journal: new RunJournal(manifest, directory), events };
  }

  /** 串行追加一条完整 JSONL 事实；调用成功代表该事实已写入本机文件系统。 */
  async append(event: JournalEvent): Promise<void> {
    validateEvent(event, this.manifest.runId);
    const operation = this.#appendQueue.then(() => appendFile(join(this.directory, "journal.jsonl"), `${JSON.stringify(event)}\n`, "utf8"));
    this.#appendQueue = operation.catch(() => undefined);
    return operation;
  }

  /** 等待所有已排队的追加操作完成。 */
  async flush(): Promise<void> {
    await this.#appendQueue;
  }

  /** 耐久写入一个节点完成结果；仅接受 JSON 对象。 */
  async writeResult(nodeId: string, result: unknown): Promise<string> {
    if (!isJsonObject(result)) throw new Error("节点完成结果必须是 JSON 对象。");
    const relativePath = join("nodes", nodeDirectoryName(nodeId), "result.json");
    await atomicWrite(join(this.directory, relativePath), `${JSON.stringify({ nodeId, result }, null, 2)}\n`);
    return relativePath;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

/** 运行时验证 Manifest，避免可修改的 JSON 文件绕过类型约束。 */
export function validateManifest(value: unknown): RunManifest {
  if (!isPlainObject(value)) throw new Error("Manifest 必须是对象。");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.runId !== "string") throw new Error("Manifest 缺少 runId。");
  validateRunId(manifest.runId);
  if (manifest.runtimeVersion !== 1) throw new Error("Manifest Runtime 版本不兼容。");
  if (typeof manifest.workflowHash !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.workflowHash)) throw new Error("Manifest workflowHash 无效。");
  if (typeof manifest.cwd !== "string" || !manifest.cwd.startsWith("/")) throw new Error("Manifest cwd 必须为绝对路径。");
  if (!isJsonObject(manifest.input)) throw new Error("Manifest input 必须为 JSON-safe 对象。");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error("Manifest createdAt 无效。");
  if (!isWorkflowMeta(manifest.workflow)) throw new Error("Manifest workflow 无效。");
  return manifest as unknown as RunManifest;
}

export function validateEvent(value: unknown, expectedRunId: string): JournalEvent {
  if (!isPlainObject(value) || typeof value.type !== "string") throw new Error("Journal 事件必须是对象。");
  const event = value as Record<string, unknown>;
  if (event.runId !== expectedRunId || typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) throw new Error("Journal 事件身份或时间无效。");
  if (event.nodeId !== null && typeof event.nodeId !== "string") throw new Error("Journal nodeId 无效。");
  if (event.agentSessionId !== null) throw new Error("本阶段 Journal agentSessionId 必须为 null。");
  if (event.diagnostic !== null && typeof event.diagnostic !== "string") throw new Error("Journal diagnostic 无效。");
  switch (event.type) {
    case "run.created":
      if (event.nodeId !== null || event.runStatus !== "running") throw new Error("run.created payload 无效。");
      break;
    case "phase.changed":
      if (event.nodeId !== null || typeof event.title !== "string" || !event.title.trim()) throw new Error("phase.changed payload 无效。");
      break;
    case "log.written":
      if (event.nodeId !== null || typeof event.message !== "string") throw new Error("log.written payload 无效。");
      break;
    case "agent.created":
      if (typeof event.nodeId !== "string" || !Number.isInteger(event.sequence) || (event.sequence as number) < 1 || (event.phase !== null && typeof event.phase !== "string") || !isNormalizedRequest(event.request)) throw new Error("agent.created payload 无效。");
      break;
    case "agent.status":
      if (typeof event.nodeId !== "string" || !isAgentStatus(event.status)) throw new Error("agent.status payload 无效。");
      break;
    case "agent.completed":
      if (typeof event.nodeId !== "string" || typeof event.resultPath !== "string" || !isJsonObject(event.result)) throw new Error("agent.completed payload 无效。");
      break;
    case "run.status":
      if (event.nodeId !== null || !isRunStatus(event.status)) throw new Error("run.status payload 无效。");
      break;
    default:
      throw new Error("Journal 事件类型未知。");
  }
  return event as unknown as JournalEvent;
}

function isWorkflowMeta(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.name !== "string" || typeof value.description !== "string" || !Array.isArray(value.phases)) return false;
  return value.phases.length > 0 && value.phases.every((phase) => isPlainObject(phase) && typeof phase.title === "string" && phase.title.trim() !== "");
}

function isNormalizedRequest(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.id !== "string" || (value.cli !== "codex" && value.cli !== "claude") || (value.sandbox !== "read-only" && value.sandbox !== "workspace-write") || typeof value.cwd !== "string" || typeof value.prompt !== "string") return false;
  return (value.phase === undefined || typeof value.phase === "string") && (value.input === undefined || isJsonObject(value.input));
}

function isAgentStatus(value: unknown): boolean { return value === "queued" || value === "running" || value === "waiting_for_input" || value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"; }
function isRunStatus(value: unknown): boolean { return value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"; }

function isTruncatedJsonTail(line: string): boolean {
  const text = line.trim();
  return text.startsWith("{") || text.startsWith("[") || text.startsWith("\"");
}

/** 验证 completed 事件对应的独立结果文件，防止 Journal 单独伪造完成状态。 */
async function validateCompletedResult(directory: string, event: Extract<JournalEvent, { type: "agent.completed" }>): Promise<void> {
  if (event.nodeId === null) throw new Error("agent.completed 缺少 nodeId。");
  const expectedPath = join("nodes", nodeDirectoryName(event.nodeId), "result.json");
  if (event.resultPath !== expectedPath) throw new Error("agent.completed resultPath 不匹配节点目录。");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(directory, expectedPath), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`agent.completed 结果文件不可读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value) || value.nodeId !== event.nodeId || !isJsonObject(value.result) || !isDeepStrictEqual(value.result, event.result)) {
    throw new Error("agent.completed 结果文件与 Journal 事件不一致。");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
