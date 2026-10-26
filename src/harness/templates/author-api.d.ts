import type { JsonObject } from "../../shared/json";
import type { AgentOptions } from "../../shared/workflow-types";

/**
 * 受限草案可引用的宿主注入作者 API。
 *
 * 内置预置的编排脚本是受限草案形态：没有 import/export（脚本而非模块），
 * 运行时由受限桥注入 `agent`/`phase`/`parallel`/`pipeline`/`log`/`decisionGate`。
 * 这些声明只在本目录的独立工程里生效（见 tsconfig.json），不会污染主工程；
 * 参数类型直接取自真实实现，因此选项写错（例如非法 cli、sandbox 或 schema 形状）
 * 会在类型检查阶段暴露，而不是等到运行时。
 */
declare global {
  /** 结果放宽为 unknown：受限草案对节点结果一律显式断言，不依赖隐式形状。 */
  function agent<T = unknown>(prompt: string, options: AgentOptions): Promise<T | null>;
  function phase(title: string): void;
  function parallel<T>(tasks: readonly (() => Promise<T> | T)[]): Promise<Array<T | null>>;
  function pipeline<T>(items: readonly T[], ...stages: ((value: unknown) => unknown | Promise<unknown>)[]): Promise<Array<unknown | null>>;
  function log(message: string): void;
  function decisionGate(id: string, question: string, answerSchema?: JsonObject): Promise<JsonObject>;
  function decisionGate(request: { id: string; question: string; answerSchema?: JsonObject }): Promise<JsonObject>;
}

export {};
