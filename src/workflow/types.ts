/**
 * Workflow 预先声明的副作用范围。
 * 这是运行前的意图声明，不是权限本身；未来 Runtime 仍会检查 sandbox、cwd 等条件。
 */
export type SideEffects = "none" | "workspace";

/** Runtime 在启动任何 Agent 前读取并校验的 Workflow 静态说明。 */
export type WorkflowMeta = {
  /** Workflow 的稳定名称，例如 `auth-review`。必须使用 kebab-case。 */
  name: string;
  /** 给人阅读的一行简介；不能换行，方便 CLI、JSONL 与列表视图展示。 */
  description: string;
  /** 逻辑阶段，例如 `["discover", "review"]`；每项非空且不可重复。 */
  phases: string[];
  /** `none` 代表只读；`workspace` 表示可能写入，但仍需通过额外安全检查。 */
  sideEffects: SideEffects;
};

/**
 * Runtime 注入给 Workflow 的唯一宿主 API。
 * Workflow 只能经由 ctx.agent() 请求 Agent，以统一接受事件、预算和安全策略管理。
 */
export interface WorkflowContext {
  /**
   * 请求 Runtime 执行一个独立 Agent。
   * @param prompt 交给 Agent 的任务说明；应明确目标、上下文和期望输出。
   * @param options 节点标记；省略后 label 默认为 `agent`。
   * @returns Agent 的最终输出及运行元数据；错误会向上抛给 Workflow。
   */
  agent(prompt: string, options?: import("../runtime/types").AgentOptions): Promise<import("../runtime/types").AgentResult>;

  /**
   * 并行执行一组彼此独立的任务，并在全部结束后按原始输入顺序返回结果。
   * @param tasks 不带参数的异步任务数组。任务应只依赖调用前已经可用的上下文，不能依赖同批其他任务的结果。
   * @returns 与 tasks 等长的数组：成功项保留结果，抛错或拒绝的项为 `null`；空数组立即返回 `[]`。
   * 不会因单项失败取消其他任务，因此调用方应在下游显式处理 `null`。
   */
  parallel<T>(tasks: Array<() => Promise<T>>): Promise<Array<T | null>>;
}

/**
 * 受信任本地 Workflow 的模块形状。
 * 支持 default 或命名 run 入口；两者均不存在时，Runtime 会在启动 Agent 前拒绝它。
 */
export type WorkflowModule<Args = unknown, Result = unknown> = {
  /** 运行前可读取的 Workflow 静态元数据；Runtime 会先校验它。 */
  meta: WorkflowMeta;
  /**
   * 推荐的 ESM 默认执行入口。
   * @param ctx Runtime 注入的宿主能力，不应由 Workflow 自行构造。
   * @param args 此次运行的业务参数，具体形状由 Args 泛型定义。
   * @returns Workflow 的最终值，具体形状由 Result 泛型定义。
   */
  default?: (ctx: WorkflowContext, args: Args) => Promise<Result>;
  /**
   * 与 default 作用相同的命名入口，方便偏好具名导出的 Workflow。
   * Runtime 优先使用 default；两者都没有时会拒绝运行。
   */
  run?: (ctx: WorkflowContext, args: Args) => Promise<Result>;
};
