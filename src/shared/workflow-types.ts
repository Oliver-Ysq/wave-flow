import type { JsonObject, JsonValue } from "./json";

/** Workflow 可使用的正常交互式 CLI；运行时只允许这两个 Adapter。 */
export type AgentCli = "codex" | "claude";

/** Agent CLI 的可写范围；默认 read-only，影响后续 Adapter 的 sandbox 启动参数。 */
export type AgentSandbox = "read-only" | "workspace-write";

/** 节点结果的 JSON Schema；本层仅传递，后续 Control Server 负责运行时校验。 */
export type JsonSchema = Readonly<Record<string, JsonValue>>;

/** 在主视图中展示的一项有序 Workflow 阶段。 */
export type WorkflowPhase = {
  /** 阶段标题；必须非空且在同一 Workflow meta 中唯一，phase() 必须精确匹配。 */
  readonly title: string;
};

/** Workflow 的静态、JSON-safe 元数据。 */
export type WorkflowMeta = {
  /** 稳定 Workflow 标识；必须为 kebab-case，供 Run 与展示关联。 */
  readonly name: string;
  /** 面向用户的非空单行说明；用于 CLI 与本地 Web 展示。 */
  readonly description: string;
  /** 有序且 title 唯一的阶段计划；决定 Phase → Agent 主视图分组。 */
  readonly phases: readonly WorkflowPhase[];
  /** 可选的最小可运行 JSON 输入；仅作示例，不改变本次 Run 参数。 */
  readonly exampleArgs?: JsonObject;
};

/** Workflow 作者为一个 Agent 节点声明的请求参数。 */
export type AgentOptions = {
  /** Run 内唯一且稳定的节点身份；最长 120 字符，参与后续会话和 replay 绑定。 */
  readonly id: string;
  /** 要启动的正常交互式 CLI Adapter；仅允许 codex 或 claude。 */
  readonly cli: AgentCli;
  /** 可选展示名称；省略时运行时使用 id，不影响节点稳定身份。 */
  readonly label?: string;
  /** 可选工作目录；省略时后续 Runtime 使用 Run 的项目 cwd。 */
  readonly cwd?: string;
  /** Adapter 支持时请求的模型；省略时由 Adapter 决定默认模型。 */
  readonly model?: string;
  /** 可选节点结果 Schema；由后续 Control Server 校验 complete 结果。 */
  readonly schema?: JsonSchema;
  /** CLI sandbox 权限；省略时规范化为 read-only，禁止其他权限值。 */
  readonly sandbox?: AgentSandbox;
  /** 显式上游 JSON 输入；参与后续 Prompt 构造和 replay 指纹。 */
  readonly input?: JsonObject;
};

/** Runtime 规范化后的 Agent 请求；所有默认值已固定，供宿主安全消费。 */
export type NormalizedAgentRequest = Omit<AgentOptions, "cwd" | "sandbox"> & {
  /** 实际请求的 sandbox；总是 read-only 或 workspace-write。 */
  readonly sandbox: AgentSandbox;
  /** 实际工作目录；总是 Run cwd 或其已验证的子目录。 */
  readonly cwd: string;
  /** 原始任务说明；必须为非空字符串。 */
  readonly prompt: string;
  /** 调用 agent() 时生效的已声明阶段标题。 */
  readonly phase: string | undefined;
};

/** 一个接受前一阶段值并返回下一阶段值的 pipeline 函数。 */
export type PipelineStage = (value: unknown) => Promise<unknown> | unknown;

/** 动态导入后可执行的 Workflow 模块。 */
export type WorkflowModule<Args = unknown, Result = unknown> = {
  /** 运行前验证的静态元数据。 */
  readonly meta: WorkflowMeta;
  /** 唯一支持的执行入口；必须为 async function，接收一次 Run 的业务参数。 */
  readonly default: (args: Args) => Promise<Result>;
};
