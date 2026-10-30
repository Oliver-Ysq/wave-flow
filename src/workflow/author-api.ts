import { isJsonObject } from "../shared/json";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "../shared/json";
import type { AgentOptions, PipelineStage } from "../shared/workflow-types";
import { createExecutionBatch, currentExecutionBatch, requireWorkflowContext, runInConcurrentWorkflowScope, trackWorkflowOperation } from "./execution-context";
import { WorkflowContractError } from "./errors";
import { cliUnavailableReason, isCliSelectable } from "../shared/cli-availability";

const agentId = /^[A-Za-z0-9._:/-]{1,120}$/;

/** 创建一个独立 Agent 节点请求；本阶段仅委派内存宿主，不启动 CLI。 */
export function agent<T extends JsonObject = JsonObject>(prompt: string, options: AgentOptions): Promise<T | null> {
  const context = requireWorkflowContext();
  if (typeof prompt !== "string" || prompt.trim() === "") throw new WorkflowContractError("agent() 的 prompt 必须为非空字符串。");
  validateAgentOptions(options);
  if (context.agentIds.has(options.id)) throw new WorkflowContractError(`agent() 的 id 在同一 Run 内必须唯一：${options.id}`);
  context.agentIds.add(options.id);
  // cwd 规范化包含 realpath 的异步等待。必须在进入等待前冻结当前 Phase、阶段访问和
  // 调度批次，否则作者紧接着 phase() 时会把此前已调用的 agent() 错归到后一个阶段。
  const phase = context.currentPhase;
  const phaseVisit = context.currentPhaseVisit ?? { executionAttemptId: 1, phaseVisitId: 0, title: phase ?? "", occurrence: 0 };
  const executionBatch = currentExecutionBatch();
  const previousAdmission = context.agentAdmission.tail;
  let releaseAdmission!: () => void;
  context.agentAdmission.tail = new Promise<void>(resolve => { releaseAdmission = resolve; });
  return trackWorkflowOperation((async () => {
    await previousAdmission;
    let execution: Promise<T | null>;
    try {
      const cwd = await normalizeAgentCwd(options.cwd, context.cwd);
      // 保持已发布 Journal 的默认指纹稳定。当前 Codex ACP Worker 的实际权限不由这个
      // 声明字段收窄；它作为任务意图留给支持可靠 sandbox 的后续 Adapter。
      execution = context.host.agent({ ...options, cwd, prompt, sandbox: options.sandbox ?? "read-only", phase }, executionBatch, phaseVisit) as Promise<T | null>;
    } finally { releaseAdmission(); }
    return execution;
  })());
}

/** 切换之后创建的 Agent 所属阶段；仅允许声明的 title，且不能在并发范围调用。 */
export function phase(title: string): void {
  const context = requireWorkflowContext();
  if (context.concurrentDepth > 0) throw new WorkflowContractError("phase() 不能在 parallel() thunk 或 pipeline() stage 中调用。");
  if (!context.meta.phases.some((item) => item.title === title)) throw new WorkflowContractError(`phase() 必须匹配已声明的阶段：${title}`);
  context.currentPhase = title;
  context.currentPhaseVisit = context.host.phase(title);
}

/** 并行启动全部惰性任务；每项失败为 null，不取消其他任务，并保留输入顺序。 */
export async function parallel<T>(tasks: readonly (() => Promise<T> | T)[]): Promise<Array<T | null>> {
  requireWorkflowContext();
  const batch = createExecutionBatch("parallel");
  const settled = await Promise.allSettled(tasks.map((task) => inConcurrentScope(batch, () => Promise.resolve().then(task))));
  return settled.map((result) => {
    if (result.status === "fulfilled") return result.value;
    if (result.reason instanceof WorkflowContractError) throw result.reason;
    return null;
  });
}

/** 让每个 item 独立、串行地通过 stages；某 item 失败后跳过后续 stages 并返回 null。 */
export async function pipeline<T>(items: readonly T[], ...stages: readonly PipelineStage[]): Promise<Array<unknown | null>> {
  requireWorkflowContext();
  const batches = stages.map(() => createExecutionBatch("parallel"));
  return Promise.all(items.map((item) => inConcurrentScope(batches[0] ?? createExecutionBatch("parallel"), async () => {
    let value: unknown = item;
    try {
      for (const [index, stage] of stages.entries()) value = await inConcurrentScope(batches[index], () => Promise.resolve(stage(value)));
      return value;
    } catch (error) {
      if (error instanceof WorkflowContractError) throw error;
      return null;
    }
  })));
}

/** 将作者提供的诊断文本交给 Runtime 宿主；不改变业务状态。 */
export function log(message: string): void {
  const context = requireWorkflowContext();
  if (typeof message !== "string") throw new WorkflowContractError("log() 的 message 必须是字符串。");
  context.host.log(message);
}

const decisionGateId = /^[A-Za-z0-9._:/-]{1,120}$/;

/**
 * 请求一次脚本级用户决策；答案返回后脚本继续。
 * 仅用于编排层，不替代 Worker 的 block/continue，也不直接改变节点状态。
 */
export function decisionGate(
  idOrRequest: string | { readonly id: string; readonly question: string; readonly answerSchema?: JsonObject },
  question?: string,
  answerSchema?: JsonObject,
): Promise<JsonObject> {
  const context = requireWorkflowContext();
  const request = typeof idOrRequest === "string"
    ? { id: idOrRequest, question, ...(answerSchema === undefined ? {} : { answerSchema }) }
    : idOrRequest;
  if (typeof request.id !== "string" || !decisionGateId.test(request.id)) throw new WorkflowContractError("decisionGate() 的 id 必须为 1-120 位允许字符。");
  if (typeof request.question !== "string" || request.question.trim() === "") throw new WorkflowContractError("decisionGate() 的 question 必须为非空字符串。");
  if (request.answerSchema !== undefined && !isJsonObject(request.answerSchema)) throw new WorkflowContractError("decisionGate() 的 answerSchema 必须是 JSON-safe 对象。");
  return trackWorkflowOperation(context.host.decisionGate({ id: request.id, question: request.question, ...(request.answerSchema === undefined ? {} : { answerSchema: request.answerSchema }) }, context.currentPhaseVisit ?? null));
}

function validateAgentOptions(options: AgentOptions): void {
  if (!options || typeof options !== "object") throw new WorkflowContractError("agent() 必须提供 options。");
  if (!agentId.test(options.id)) throw new WorkflowContractError("agent() 的 id 必须为 1-120 位允许字符。");
  // 省略 cli 表示由本次执行在选择后补齐；显式值时仍在作者 API 层拒绝未知或已下线的 CLI。
  if (options.cli !== undefined) {
    if (options.cli !== "codex" && options.cli !== "kimi" && options.cli !== "claude" && options.cli !== "dsh") throw new WorkflowContractError("agent() 的 cli 当前仅支持 codex、kimi、claude 或 dsh。");
    // 暂时下线的 CLI 在作者 API 层显式拒绝；保留类型与校验分支，便于恢复时只改可用性开关。
    if (!isCliSelectable(options.cli)) throw new WorkflowContractError(cliUnavailableReason(options.cli) ?? "该 CLI 已暂时下线。");
  }
  if (options.label !== undefined && (typeof options.label !== "string" || options.label.trim() === "")) throw new WorkflowContractError("agent() 的 label 必须为非空字符串。");
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.trim() === "")) throw new WorkflowContractError("agent() 的 cwd 必须为非空字符串。");
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.trim() === "")) throw new WorkflowContractError("agent() 的 model 必须为非空字符串。");
  if (options.schema !== undefined) {
    if (!isJsonObject(options.schema)) throw new WorkflowContractError("agent() 的 schema 必须是 JSON-safe 对象。");
    // 在任何 Journal 事实或 Worker 会话之前静态拒绝可证明自相矛盾的 schema。
    assertSchemaSelfConsistent(options.schema, "schema");
  }
  if (options.sandbox !== undefined && options.sandbox !== "read-only" && options.sandbox !== "workspace-write") throw new WorkflowContractError("agent() 的 sandbox 必须为 read-only 或 workspace-write。");
  if (options.input !== undefined && !isJsonObject(options.input)) throw new WorkflowContractError("agent() 的 input 必须是 JSON-safe 对象。");
}

/** `type` 关键字允许的单值集合；一期不支持数组形式的联合类型。 */
const schemaTypes = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/**
 * 递归自一致性预检：只拒绝可证明自相矛盾的 schema，不是完整 JSON Schema 校验器。
 * 覆盖 type 白名单、enum 非空、properties/items 结构形状，以及
 * additionalProperties: false 与未声明 required 键的硬矛盾；逐层递归子 schema。
 */
function assertSchemaSelfConsistent(schema: JsonObject, path: string): void {
  if (schema.type !== undefined && (typeof schema.type !== "string" || !schemaTypes.has(schema.type))) {
    throw new WorkflowContractError(`agent() 的 ${path}.type 必须是 ${[...schemaTypes].join("/")} 之一。`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new WorkflowContractError(`agent() 的 ${path}.enum 必须是非空数组。`);
  }
  if (schema.properties !== undefined && !isJsonObject(schema.properties)) {
    throw new WorkflowContractError(`agent() 的 ${path}.properties 必须是 schema 对象的字典。`);
  }
  const properties = (schema.properties ?? {}) as JsonObject;
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonObject(value)) throw new WorkflowContractError(`agent() 的 ${path}.properties.${key} 必须是 schema 对象。`);
    assertSchemaSelfConsistent(value, `${path}.properties.${key}`);
  }
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    const undeclared = schema.required.filter(key => typeof key === "string" && !(key in properties));
    if (undeclared.length > 0) throw new WorkflowContractError(`agent() 的 ${path} 在 additionalProperties: false 下要求了未在 properties 声明的键：${undeclared.join(", ")}。`);
  }
  if (schema.items !== undefined) {
    if (!isJsonObject(schema.items)) throw new WorkflowContractError(`agent() 的 ${path}.items 必须是 schema 对象。`);
    assertSchemaSelfConsistent(schema.items, `${path}.items`);
  }
}

async function inConcurrentScope<T>(batch: import("../runtime/workflow-host").ExecutionBatch, callback: () => Promise<T>): Promise<T> {
  return runInConcurrentWorkflowScope(batch, callback);
}

async function normalizeAgentCwd(requestedCwd: string | undefined, runCwd: string): Promise<string> {
  if (requestedCwd !== undefined && isAbsolute(requestedCwd) === false && requestedCwd.trim().startsWith("/")) throw new WorkflowContractError("agent() 的 cwd 路径无效。");
  const candidate = isAbsolute(requestedCwd ?? "") ? requestedCwd! : resolve(runCwd, requestedCwd ?? runCwd);
  let actualCwd: string;
  try {
    actualCwd = await realpath(candidate);
  } catch (error) {
    throw new WorkflowContractError(`agent() 的 cwd 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (requestedCwd !== undefined && !isAbsolute(requestedCwd)) {
    const fromRunCwd = relative(runCwd, actualCwd);
    if (fromRunCwd.startsWith("..") || isAbsolute(fromRunCwd)) throw new WorkflowContractError("agent() 的相对 cwd 必须位于 Workflow 项目目录内。");
  }
  return actualCwd;
}
