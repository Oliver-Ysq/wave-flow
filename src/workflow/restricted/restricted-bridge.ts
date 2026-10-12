import { isJsonObject, type JsonObject } from "../../shared/json";
import type { DecisionGateRequest } from "../../runtime/workflow-host";
import { agent, log, parallel, phase, pipeline } from "../author-api";
import { requireWorkflowContext, trackWorkflowOperation } from "../execution-context";
import { WorkflowContractError } from "../errors";

/**
 * 契约错误穿过 vm realm 时只能携带字符串；用固定前缀标记，宿主侧在 thunk 边界
 * 还原为 WorkflowContractError，保证 parallel/pipeline 的"契约错误必须抛出"语义不破。
 */
const CONTRACT_MARKER = "WF_CONTRACT:";
const GATE_ID = /^[A-Za-z0-9._:/-]{1,120}$/;

/** 注入 vm realm 的宿主桥；协议为 JSON 字符串进出，脚本永远拿不到宿主 realm 对象。 */
export type RestrictedHostBridge = {
  /** agent / phase / log / decisionGate 派发；同步操作直接返回 envelope 字符串。 */
  readonly call: (op: string, payloadJson: string) => string | Promise<string>;
  /** parallel 的 thunk 无法序列化，以 vm realm 函数引用穿过桥；结果仍按 envelope 返回。 */
  readonly parallel: (thunks: readonly unknown[]) => Promise<string>;
  /** pipeline 的 stage 同上；items 是 vm realm 值，仅在宿主暂存后立即还给 vm stage。 */
  readonly pipeline: (items: readonly unknown[], stages: readonly unknown[]) => Promise<string>;
};

/** 创建一次 Execution 的宿主桥；所有作者 API 调用仍走真实 author-api 与 ALS 上下文。 */
export function createRestrictedHostBridge(): RestrictedHostBridge {
  return {
    call: (op, payloadJson) => {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        return fail(new WorkflowContractError("受限桥 payload 不是有效 JSON。"));
      }
      // phase / log 必须同步生效：脚本紧随其后的 agent() 依赖已更新的当前阶段。
      if (op === "phase") {
        try {
          phase(asNonEmptyString(payload, "phase() 的 title"));
          return ok(null);
        } catch (error) { return fail(error); }
      }
      if (op === "log") {
        try {
          log(typeof payload === "string" ? payload : String(payload));
          return ok(null);
        } catch (error) { return fail(error); }
      }
      if (op === "agent") {
        return (async () => {
          try {
            if (!Array.isArray(payload)) throw new WorkflowContractError("agent() 桥参数必须是数组。");
            return ok(await agent(payload[0], payload[1]));
          } catch (error) { return fail(error); }
        })();
      }
      if (op === "decisionGate") {
        return (async () => {
          try {
            return ok(await decisionGate(payload));
          } catch (error) { return fail(error); }
        })();
      }
      return fail(new WorkflowContractError(`未知受限 API 操作：${op}`));
    },
    parallel: async (thunks) => {
      try {
        const tasks = thunks.map((thunk) => {
          if (typeof thunk !== "function") throw new WorkflowContractError("parallel() 的每项必须是返回 Promise 的函数。");
          return () => reviveContractErrors(thunk as () => unknown);
        });
        return ok(await parallel(tasks));
      } catch (error) { return fail(error); }
    },
    pipeline: async (items, stages) => {
      try {
        const wrapped = stages.map((stage) => {
          if (typeof stage !== "function") throw new WorkflowContractError("pipeline() 的每个 stage 必须是函数。");
          return (value: unknown) => reviveContractErrors(() => (stage as (input: unknown) => unknown)(value));
        });
        return ok(await pipeline(items, ...wrapped));
      } catch (error) { return fail(error); }
    },
  };
}

/** 宿主侧 decisionGate：校验请求形状后委派宿主；即使脚本未 await 也纳入 Run 收尾等待。 */
async function decisionGate(request: unknown): Promise<JsonObject> {
  const context = requireWorkflowContext();
  // 作者既可传显式对象，也可使用更接近常规函数 API 的三参数形式。
  // vm 侧统一把参数 JSON 数组传入；两条路径最终都归一化为同一 Journal 契约。
  if (Array.isArray(request)) {
    const [id, question, answerSchema] = request;
    request = { id, question, ...(answerSchema === undefined ? {} : { answerSchema }) };
  }
  if (!isJsonObject(request)) throw new WorkflowContractError("decisionGate() 的请求必须是 JSON 对象。");
  if (typeof request.id !== "string" || !GATE_ID.test(request.id)) throw new WorkflowContractError("decisionGate() 的 id 必须为 1-120 位允许字符。");
  if (typeof request.question !== "string" || request.question.trim() === "") throw new WorkflowContractError("decisionGate() 的 question 必须为非空字符串。");
  if (request.answerSchema !== undefined && !isJsonObject(request.answerSchema)) throw new WorkflowContractError("decisionGate() 的 answerSchema 必须是 JSON-safe 对象。");
  const normalized: DecisionGateRequest = { id: request.id, question: request.question, answerSchema: request.answerSchema as JsonObject | undefined };
  return trackWorkflowOperation(context.host.decisionGate(normalized, context.currentPhaseVisit ?? null));
}

/** vm 侧抛出的契约错误带标记前缀；在 thunk 边界还原类型，供 author-api 正确重抛。 */
async function reviveContractErrors(operation: () => unknown): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    throw reviveContractError(error);
  }
}

/** 将带标记的 vm 侧错误还原为宿主 WorkflowContractError；其余错误原样传播。 */
export function reviveContractError(error: unknown): unknown {
  // 跨 realm 的 Error 不通过宿主 instanceof 检查，必须按结构识别标记。
  const message = typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : null;
  if (message !== null && message.startsWith(CONTRACT_MARKER)) {
    return new WorkflowContractError(message.slice(CONTRACT_MARKER.length));
  }
  return error;
}

function ok(value: unknown): string {
  return JSON.stringify({ ok: true, value: value === undefined ? null : value });
}

function fail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ ok: false, contract: error instanceof WorkflowContractError, error: message });
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new WorkflowContractError(`${label} 必须为非空字符串。`);
  return value;
}

/**
 * vm realm 内的 API 包装层源码。包装函数在 vm realm 创建，其 constructor 属于
 * vm realm；宿主桥函数在包装创建后立即从全局删除，脚本经静态白名单也无法引用它。
 */
export const RESTRICTED_BRIDGE_SOURCE = `"use strict";
const __wfCall = globalThis.__wf_call;
const __wfParallel = globalThis.__wf_parallel;
const __wfPipeline = globalThis.__wf_pipeline;
delete globalThis.__wf_call;
delete globalThis.__wf_parallel;
delete globalThis.__wf_pipeline;
const __wfRaise = (envelope) => {
  const parsed = JSON.parse(envelope);
  if (parsed.ok) return parsed.value;
  throw new Error((parsed.contract ? "WF_CONTRACT:" : "") + parsed.error);
};
globalThis.agent = async (prompt, options) => __wfRaise(await __wfCall("agent", JSON.stringify([prompt, options === undefined ? null : options])));
globalThis.phase = (title) => __wfRaise(__wfCall("phase", JSON.stringify(title)));
globalThis.log = (message) => __wfRaise(__wfCall("log", JSON.stringify(message)));
globalThis.decisionGate = async (...args) => __wfRaise(await __wfCall("decisionGate", JSON.stringify(args.length === 1 ? args[0] : args)));
globalThis.parallel = async (tasks) => __wfRaise(await __wfParallel(tasks));
globalThis.pipeline = async (items, ...stages) => __wfRaise(await __wfPipeline(items, stages));
`;
