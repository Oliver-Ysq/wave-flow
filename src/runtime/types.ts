import type { AgentAdapter } from "../adapters/agent-adapter";
import type { EventSink } from "../events/types";

/** 单次 Agent 调用的可选标记；label 供事件、日志和未来回放节点使用。 */
export type AgentOptions = {
  /** 本次调用的人类可读节点名；省略时 Runtime 使用 `agent`。 */
  label?: string;
  /** 调用所属的逻辑阶段；后续会用于阶段级事件、TUI 展示和统计。 */
  phase?: string;
  /**
   * 约束 Agent 最终输出形状的 JSON Schema。
   * 提供后 AgentResult.output 会由 Runtime 解析并校验为结构化值；不提供时 output 保持文本。
   */
  schema?: object;
};

/** Agent 完成独立 ReAct Loop 后交给 Workflow 的结果。 */
export type AgentResult<T = string> = {
  /** Agent 最终输出；未提供 schema 时为文本，提供 schema 后为已验证的 T。 */
  output: T;
  /** 当前是否命中历史 Journal；尚未实现 Journal，因此现在恒为 false。 */
  replayed: boolean;
  /** 当前整次 Workflow 运行的唯一标识，用于关联事件、日志和 artifacts。 */
  runId: string;
};

/** 创建 Runtime 所需的宿主依赖和运行范围。 */
export type RuntimeOptions = {
  /** 实际执行 Agent 的后端；测试中为 Fake，实现版将是 Codex CLI Adapter。 */
  adapter: AgentAdapter;
  /** 生命周期事件的输出目标；当前可使用内存收集器，CLI 阶段会使用 JSONL Writer。 */
  events: EventSink;
  /** 所有当前 Agent 调用使用的工作目录绝对路径。 */
  cwd: string;
  /** 可选的整次运行标识；省略时 Runtime 会生成随机 UUID。 */
  runId?: string;
};
