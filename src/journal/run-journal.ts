import { appendFile, chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject, type JsonObject } from "../shared/json";
import { nodeDirectoryName, runDirectory, runsRoot, validateRunId, waveFlowHome } from "./paths";
import { COMPATIBLE_RUNTIME_VERSIONS, type JournalEvent, type RunManifest } from "./types";
import { RunStateMachine } from "../runtime/run-state-machine";
import type { SessionIdentity } from "../sessions/types";

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
    await ensureProductionStateHome(root);
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(directory);
    await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writePrivateFile(join(directory, "journal.jsonl"), "");
    const journal = new RunJournal(manifest, directory);
    await journal.append({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    return journal;
  }

  /** 打开已存在 Run，返回 Manifest 与全部有效 Journal 事实；中间损坏必须拒绝。 */
  static async open(runId: string, root = runsRoot()): Promise<{ journal: RunJournal; events: readonly JournalEvent[] }> {
    validateRunId(runId);
    try { await assertProductionStateHome(root); await assertPrivateDirectory(root); } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code === "ENOENT") throw new Error("指定 Run 不存在或 manifest 不可读取。");
      throw error;
    }
    const directory = runDirectory(root, runId);
    let manifestSource: string;
    try { manifestSource = await readFile(join(directory, "manifest.json"), "utf8"); } catch { throw new Error("指定 Run 不存在或 manifest 不可读取。"); }
    let manifestValue: unknown;
    try { manifestValue = JSON.parse(manifestSource) as unknown; } catch (error) { throw new Error(`Run manifest JSON 无效：${error instanceof Error ? error.message : String(error)}`); }
    const manifest = validateManifest(manifestValue);
    if (manifest.runId !== runId) throw new Error("Manifest runId 与请求不一致。");
    let text: string;
    try { text = await readFile(join(directory, "journal.jsonl"), "utf8"); } catch { throw new Error("指定 Run 的 Journal 不可读取。"); }
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
        if (event.type === "agent.completed") {
          if (event.nodeId === null) throw new Error("agent.completed 缺少 nodeId。");
          await validateCompletedResult(directory, event, state.agent(event.nodeId).request.schema ?? {});
        }
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
  async writeResult(nodeId: string, result: unknown, agentSessionId?: string): Promise<string> {
    if (!isJsonObject(result)) throw new Error("节点完成结果必须是 JSON 对象。");
    const relativePath = attemptPath(nodeId, agentSessionId, "result.json");
    await atomicWrite(join(this.directory, relativePath), `${JSON.stringify({ nodeId, result }, null, 2)}\n`);
    return relativePath;
  }

  /** 耐久写入节点结果的 Schema 校验证据；必须早于 completed Journal 事件。 */
  async writeValidation(nodeId: string, schema: unknown, result: JsonObject, agentSessionId?: string): Promise<string> {
    const relativePath = attemptPath(nodeId, agentSessionId, "validation.json");
    await atomicWrite(join(this.directory, relativePath), `${JSON.stringify({ nodeId, schema, result, valid: true }, null, 2)}\n`);
    return relativePath;
  }
}

/** 生产 Run Store 不能经 ~/.wave-flow 的软链接或宽权限目录绕过检查。 */
async function ensureProductionStateHome(root: string): Promise<void> {
  if (resolve(root) !== resolve(runsRoot())) return;
  await ensurePrivateDirectory(waveFlowHome());
}

async function assertProductionStateHome(root: string): Promise<void> {
  if (resolve(root) !== resolve(runsRoot())) return;
  await assertPrivateDirectory(waveFlowHome());
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensurePrivateDirectory(dirname(filePath));
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writePrivateFile(temporaryPath, content);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path);
  // 已有目录的安全性已由 assertPrivateDirectory 验证；不因 ACL 拒绝冗余 chmod
  // 而让读取已有 Run 或写入新事件失败。
  if (created !== undefined) await chmod(path, 0o700);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Wave Flow 状态目录必须是真实目录。");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Wave Flow 状态目录不属于当前用户。");
  if ((info.mode & 0o077) !== 0) throw new Error("Wave Flow 状态目录权限过宽。");
}

/** 运行时验证 Manifest，避免可修改的 JSON 文件绕过类型约束。 */
export function validateManifest(value: unknown): RunManifest {
  if (!isPlainObject(value)) throw new Error("Manifest 必须是对象。");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.runId !== "string") throw new Error("Manifest 缺少 runId。");
  validateRunId(manifest.runId);
  if (!COMPATIBLE_RUNTIME_VERSIONS.includes(manifest.runtimeVersion as never)) throw new Error("Manifest Runtime 版本不兼容。");
  if (typeof manifest.clientRequestId !== "string" || !/^[0-9a-f-]{36}$/i.test(manifest.clientRequestId)) throw new Error("Manifest clientRequestId 无效。");
  if (typeof manifest.workflowHash !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.workflowHash)) throw new Error("Manifest workflowHash 无效。");
  if (typeof manifest.workflowPath !== "string" || !manifest.workflowPath.startsWith("/")) throw new Error("Manifest workflowPath 必须为绝对路径。");
  if (typeof manifest.workflowProjectCwd !== "string" || !manifest.workflowProjectCwd.startsWith("/")) throw new Error("Manifest workflowProjectCwd 必须为绝对路径。");
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
  if (event.agentSessionId !== null && (typeof event.agentSessionId !== "string" || !event.agentSessionId.trim())) throw new Error("Journal agentSessionId 无效。");
  if (event.diagnostic !== null && typeof event.diagnostic !== "string") throw new Error("Journal diagnostic 无效。");
  switch (event.type) {
    case "run.created":
      if (event.nodeId !== null || event.runStatus !== "running") throw new Error("run.created payload 无效。");
      break;
    case "execution-attempt.started":
      if (event.nodeId !== null || !isPositiveInteger(event.executionAttemptId)) throw new Error("execution-attempt.started payload 无效。");
      break;
    case "phase.entered":
      if (event.nodeId !== null || !isPositiveInteger(event.executionAttemptId) || !isPositiveInteger(event.phaseVisitId) || typeof event.title !== "string" || !event.title.trim() || !isPositiveInteger(event.occurrence)) throw new Error("phase.entered payload 无效。");
      break;
    case "phase.changed":
      if (event.nodeId !== null || typeof event.title !== "string" || !event.title.trim()) throw new Error("phase.changed payload 无效。");
      break;
    case "log.written":
      if (event.nodeId !== null || typeof event.message !== "string") throw new Error("log.written payload 无效。");
      break;
    case "agent.created":
      if (typeof event.nodeId !== "string" || !Number.isInteger(event.sequence) || (event.sequence as number) < 1 || (event.logicalSequence !== undefined && (!Number.isInteger(event.logicalSequence) || (event.logicalSequence as number) < 1)) || (event.phase !== null && typeof event.phase !== "string") || (event.executionAttemptId !== undefined && !isPositiveInteger(event.executionAttemptId)) || (event.phaseVisitId !== undefined && !isPositiveInteger(event.phaseVisitId)) || !isNormalizedRequest(event.request)) throw new Error("agent.created payload 无效。");
      break;
    case "agent.restarted":
      if (typeof event.nodeId !== "string" || !Number.isInteger(event.sequence) || (event.sequence as number) < 1 || (event.logicalSequence !== undefined && (!Number.isInteger(event.logicalSequence) || (event.logicalSequence as number) < 1)) || typeof event.newAgentSessionId !== "string" || !event.newAgentSessionId.trim() || typeof event.invalidatedByPriorRestart !== "boolean" || (event.executionAttemptId !== undefined && !isPositiveInteger(event.executionAttemptId)) || (event.phaseVisitId !== undefined && !isPositiveInteger(event.phaseVisitId)) || !isNormalizedRequest(event.request)) throw new Error("agent.restarted payload 无效。");
      break;
    case "agent.status":
      if (typeof event.nodeId !== "string" || !isAgentStatus(event.status)) throw new Error("agent.status payload 无效。");
      break;
    case "agent.session":
      if (typeof event.nodeId !== "string" || !isSessionDelivery(event.delivery) || !isSessionIdentity(event.session) || event.session.runId !== event.runId || event.session.nodeId !== event.nodeId || event.session.agentSessionId !== event.agentSessionId) throw new Error("agent.session payload 无效。");
      if (event.delivery === "tmux" && event.appServer !== undefined) throw new Error("普通 tmux 投递不得携带 App Server 坐标。");
      if (event.delivery === "codex-rpc" && !isAppServerCoordinate(event.appServer)) throw new Error("App Server 投递缺少有效坐标。");
      break;
    case "agent.recovered":
      if (typeof event.nodeId !== "string" || typeof event.agentSessionId !== "string" || !isAppServerCoordinate(event.appServer)) throw new Error("agent.recovered payload 无效。 ");
      break;
    case "agent.viewer":
      if (typeof event.nodeId !== "string" || !isSessionIdentity(event.session) || event.session.runId !== event.runId || event.session.nodeId !== event.nodeId || event.session.agentSessionId !== event.agentSessionId) throw new Error("agent.viewer payload 无效。 ");
      break;
    case "agent.completed":
      if (typeof event.nodeId !== "string" || typeof event.resultPath !== "string" || !isJsonObject(event.result) || (event.validationPath !== undefined && typeof event.validationPath !== "string")) throw new Error("agent.completed payload 无效。");
      break;
    case "block.created":
      if (typeof event.nodeId !== "string" || typeof event.blockRequestId !== "string" || !event.blockRequestId.trim() || typeof event.needHelp !== "string" || !event.needHelp.trim() || (event.answerSchema !== undefined && !isJsonObject(event.answerSchema))) throw new Error("block.created payload 无效。");
      break;
    case "block.answered":
      if (typeof event.nodeId !== "string" || typeof event.blockRequestId !== "string" || !event.blockRequestId.trim() || !isJsonObject(event.answer)) throw new Error("block.answered payload 无效。");
      break;
    case "agent.continued":
      if (typeof event.nodeId !== "string" || typeof event.blockRequestId !== "string" || !event.blockRequestId.trim()) throw new Error("agent.continued payload 无效。");
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
  if (!isPlainObject(value) || typeof value.id !== "string" || value.cli !== "codex" || (value.sandbox !== "read-only" && value.sandbox !== "workspace-write") || typeof value.cwd !== "string" || typeof value.prompt !== "string") return false;
  return (value.phase === undefined || typeof value.phase === "string") && (value.input === undefined || isJsonObject(value.input));
}

function isAgentStatus(value: unknown): boolean { return value === "queued" || value === "running" || value === "blocked" || value === "pausing" || value === "paused" || value === "recovering" || value === "completed" || value === "cancelled" || value === "interrupted"; }
function isPositiveInteger(value: unknown): value is number { return Number.isInteger(value) && typeof value === "number" && value >= 1; }
function isRunStatus(value: unknown): boolean { return value === "running" || value === "pausing" || value === "paused" || value === "recovering" || value === "completed" || value === "cancelled" || value === "interrupted"; }
function isSessionDelivery(value: unknown): value is "tmux" | "codex-rpc" { return value === "tmux" || value === "codex-rpc"; }

function isSessionIdentity(value: unknown): value is SessionIdentity {
  if (!isPlainObject(value)) return false;
  return value.backend === "tmux" && typeof value.sessionName === "string" && value.sessionName.trim() !== "" && typeof value.backendRef === "string" && value.backendRef.startsWith("/") && typeof value.runId === "string" && typeof value.nodeId === "string" && typeof value.agentSessionId === "string" && value.agentSessionId.trim() !== "" && value.cli === "codex" && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && (value.identityFile === undefined || (typeof value.identityFile === "string" && value.identityFile.startsWith("/"))) && (value.reclaimTokenHash === undefined || (typeof value.reclaimTokenHash === "string" && /^[0-9a-f]{64}$/i.test(value.reclaimTokenHash)));
}

function isAppServerCoordinate(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isLoopbackWebSocketEndpoint(value.endpoint) && typeof value.threadId === "string" && value.threadId.trim() !== "" && typeof value.turnId === "string" && value.turnId.trim() !== "" && value.protocolVersion === 1;
}

/** URL 会将无尾随斜杠 endpoint 规范化为 `/`；不能用字符串正则把等价坐标拒绝。 */
function isLoopbackWebSocketEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && /^\d+$/.test(url.port) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}

function isTruncatedJsonTail(line: string): boolean {
  const text = line.trim();
  return text.startsWith("{") || text.startsWith("[") || text.startsWith("\"");
}

/** 验证 completed 事件对应的独立结果文件，防止 Journal 单独伪造完成状态。 */
async function validateCompletedResult(directory: string, event: Extract<JournalEvent, { type: "agent.completed" }>, expectedSchema: unknown): Promise<void> {
  if (event.nodeId === null) throw new Error("agent.completed 缺少 nodeId。");
  const expectedPath = attemptPath(event.nodeId, event.agentSessionId ?? undefined, "result.json");
  const legacyPath = join("nodes", nodeDirectoryName(event.nodeId), "result.json");
  if (event.resultPath !== expectedPath && event.resultPath !== legacyPath) throw new Error("agent.completed resultPath 不匹配节点目录。");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(directory, event.resultPath), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`agent.completed 结果文件不可读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value) || value.nodeId !== event.nodeId || !isJsonObject(value.result) || !isDeepStrictEqual(value.result, event.result)) {
    throw new Error("agent.completed 结果文件与 Journal 事件不一致。");
  }
  if (event.validationPath !== undefined) await validateCompletedValidation(directory, event, expectedSchema);
}

async function validateCompletedValidation(directory: string, event: Extract<JournalEvent, { type: "agent.completed" }>, expectedSchema: unknown): Promise<void> {
  if (event.nodeId === null || event.validationPath === undefined) throw new Error("agent.completed validation 记录无效。");
  const expectedPath = attemptPath(event.nodeId, event.agentSessionId ?? undefined, "validation.json");
  const legacyPath = join("nodes", nodeDirectoryName(event.nodeId), "validation.json");
  if (event.validationPath !== expectedPath && event.validationPath !== legacyPath) throw new Error("agent.completed validationPath 不匹配节点目录。");
  let value: unknown;
  try { value = JSON.parse(await readFile(join(directory, event.validationPath), "utf8")) as unknown; } catch (error) { throw new Error(`agent.completed 校验记录不可读取：${error instanceof Error ? error.message : String(error)}`); }
  if (!isPlainObject(value) || value.nodeId !== event.nodeId || value.valid !== true || !isDeepStrictEqual(value.schema, expectedSchema) || !isJsonObject(value.result) || !isDeepStrictEqual(value.result, event.result)) throw new Error("agent.completed 校验记录与节点 schema 或结果不一致。");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** v4 attempt 结果不可覆盖旧 attempt；无 session id 的历史事件保留旧路径兼容。 */
function attemptPath(nodeId: string, agentSessionId: string | undefined, file: "result.json" | "validation.json"): string {
  return agentSessionId ? join("nodes", nodeDirectoryName(nodeId), "attempts", nodeDirectoryName(agentSessionId), file) : join("nodes", nodeDirectoryName(nodeId), file);
}
