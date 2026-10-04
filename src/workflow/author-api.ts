import { isJsonObject } from "../shared/json";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "../shared/json";
import type { AgentOptions, PipelineStage } from "../shared/workflow-types";
import { requireWorkflowContext, runInConcurrentWorkflowScope, trackWorkflowOperation } from "./execution-context";
import { WorkflowContractError } from "./errors";

const agentId = /^[A-Za-z0-9._:/-]{1,120}$/;

/** 创建一个独立 Agent 节点请求；本阶段仅委派内存宿主，不启动 CLI。 */
export function agent<T extends JsonObject = JsonObject>(prompt: string, options: AgentOptions): Promise<T | null> {
  const context = requireWorkflowContext();
  if (typeof prompt !== "string" || prompt.trim() === "") throw new WorkflowContractError("agent() 的 prompt 必须为非空字符串。");
  validateAgentOptions(options);
  if (context.agentIds.has(options.id)) throw new WorkflowContractError(`agent() 的 id 在同一 Run 内必须唯一：${options.id}`);
  context.agentIds.add(options.id);
  return trackWorkflowOperation((async () => {
    const cwd = await normalizeAgentCwd(options.cwd, context.cwd);
    return context.host.agent({ ...options, cwd, prompt, sandbox: options.sandbox ?? "read-only", phase: context.currentPhase }) as Promise<T | null>;
  })());
}

/** 切换之后创建的 Agent 所属阶段；仅允许声明的 title，且不能在并发范围调用。 */
export function phase(title: string): void {
  const context = requireWorkflowContext();
  if (context.concurrentDepth > 0) throw new WorkflowContractError("phase() 不能在 parallel() thunk 或 pipeline() stage 中调用。");
  if (!context.meta.phases.some((item) => item.title === title)) throw new WorkflowContractError(`phase() 必须匹配已声明的阶段：${title}`);
  context.currentPhase = title;
  context.host.phase(title);
}

/** 并行启动全部惰性任务；每项失败为 null，不取消其他任务，并保留输入顺序。 */
export async function parallel<T>(tasks: readonly (() => Promise<T> | T)[]): Promise<Array<T | null>> {
  requireWorkflowContext();
  const settled = await Promise.allSettled(tasks.map((task) => inConcurrentScope(() => Promise.resolve().then(task))));
  return settled.map((result) => {
    if (result.status === "fulfilled") return result.value;
    if (result.reason instanceof WorkflowContractError) throw result.reason;
    return null;
  });
}

/** 让每个 item 独立、串行地通过 stages；某 item 失败后跳过后续 stages 并返回 null。 */
export async function pipeline<T>(items: readonly T[], ...stages: readonly PipelineStage[]): Promise<Array<unknown | null>> {
  requireWorkflowContext();
  return Promise.all(items.map((item) => inConcurrentScope(async () => {
    let value: unknown = item;
    try {
      for (const stage of stages) value = await stage(value);
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

function validateAgentOptions(options: AgentOptions): void {
  if (!options || typeof options !== "object") throw new WorkflowContractError("agent() 必须提供 options。");
  if (!agentId.test(options.id)) throw new WorkflowContractError("agent() 的 id 必须为 1-120 位允许字符。");
  if (options.cli !== "codex") throw new WorkflowContractError("agent() 的 cli 当前仅支持 codex。");
  if (options.label !== undefined && (typeof options.label !== "string" || options.label.trim() === "")) throw new WorkflowContractError("agent() 的 label 必须为非空字符串。");
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.trim() === "")) throw new WorkflowContractError("agent() 的 cwd 必须为非空字符串。");
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.trim() === "")) throw new WorkflowContractError("agent() 的 model 必须为非空字符串。");
  if (options.schema !== undefined && !isJsonObject(options.schema)) throw new WorkflowContractError("agent() 的 schema 必须是 JSON-safe 对象。");
  if (options.sandbox !== undefined && options.sandbox !== "read-only" && options.sandbox !== "workspace-write") throw new WorkflowContractError("agent() 的 sandbox 必须为 read-only 或 workspace-write。");
  if (options.input !== undefined && !isJsonObject(options.input)) throw new WorkflowContractError("agent() 的 input 必须是 JSON-safe 对象。");
}

async function inConcurrentScope<T>(callback: () => Promise<T>): Promise<T> {
  return runInConcurrentWorkflowScope(callback);
}

async function normalizeAgentCwd(requestedCwd: string | undefined, runCwd: string): Promise<string> {
  const candidate = resolve(runCwd, requestedCwd ?? runCwd);
  let actualCwd: string;
  try {
    actualCwd = await realpath(candidate);
  } catch (error) {
    throw new WorkflowContractError(`agent() 的 cwd 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const fromRunCwd = relative(runCwd, actualCwd);
  if (fromRunCwd.startsWith("..") || isAbsolute(fromRunCwd)) throw new WorkflowContractError("agent() 的 cwd 必须位于 Run 的项目 cwd 内。");
  return actualCwd;
}
