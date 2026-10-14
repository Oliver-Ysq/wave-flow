import type { JsonObject } from "../shared/json";

/** Harness 会话的耐久状态；它不等同于 Workflow Run 完成状态。 */
export type HarnessStatus = "idle" | "running" | "interrupted" | "completed";

/** 用户或完整主控消息；reasoning delta 永不进入此类型。 */
export type HarnessMessage = {
  /** 稳定消息标识，用于界面 key 与分页去重。 */
  readonly id: string;
  /** 消息来源；assistant 只在完整文本耐久后出现。 */
  readonly role: "user" | "assistant";
  /** 可展示的正文；不得包含模型 key 或未完成 reasoning。 */
  readonly text: string;
  /** 耐久写入时间。 */
  readonly createdAt: string;
};

/** 主控窄工具的可恢复安全摘要；不包含参数、路径、正文、命令或输出。 */
export type HarnessToolActivity = {
  /** 服务端固定的动作名称。 */
  readonly label: string;
  /** 结束时间，用于恢复后的稳定排序。 */
  readonly finishedAt: string;
  /** 成功或未完成；不暴露底层错误详情。 */
  readonly outcome: "completed" | "failed";
};

/** 一个可恢复读取、但不认领原生 Pi session 的主控会话快照。 */
export type HarnessSnapshot = {
  /** Harness Run UUID。 */
  readonly harnessRunId: string;
  /** 所属耐久项目 id；历史未归类 Harness 为 null。 */
  readonly projectId: string | null;
  /** 已验证的项目 cwd。 */
  readonly cwd: string;
  /** 创建时冻结的主控 runtime 来源；历史档案未知时为 null。 */
  readonly runtime: import("../runtimes/types").RuntimeProvenance | null;
  /** 当前对话回合状态。 */
  readonly status: HarnessStatus;
  /** 最近一条 turn 的诊断；正常 idle 时为 null。 */
  readonly diagnostic: string | null;
  /** 用户显式归档完成的时间；进行中会话为 null。 */
  readonly completedAt: string | null;
  /** 创建时间。 */
  readonly createdAt: string;
  /** 当前已耐久的完整消息。 */
  readonly messages: readonly HarnessMessage[];
  /** 按 assistant 消息归属的工具安全摘要；历史会话默认为空。 */
  readonly toolActivitiesByMessageId: Readonly<Record<string, readonly HarnessToolActivity[]>>;
  /** 已耐久的 Workflow 草案；接受仅冻结 revision，不代表已创建或执行 Worker Run。 */
  readonly workflowRevisions: readonly WorkflowRevision[];
  /** 本 Harness 顺序拥有的 WorkflowExecution 登记；执行细节在 Execution 自己的 Run Journal。 */
  readonly executions: readonly WorkflowExecutionRecord[];
  /** 主控发起的用户决策请求；答案经独立 API 耐久，不经过回合 mutation 锁。 */
  readonly decisions: readonly HarnessDecision[];
};

/** 主控会话中的不可变 workflow.ts 草案。 */
export type WorkflowRevision = {
  /** Harness 内递增 revision；同一序号的 source/hash 不可改变。 */
  readonly revision: number;
  /** 草案 TypeScript 原文；尚未进入受限 Runtime。 */
  readonly source: string;
  /** source 的 SHA-256，用于后续 Execution 冻结与审计。 */
  readonly sourceHash: string;
  /** 草案创建时间。 */
  readonly createdAt: string;
  /** 用户是否明确接受此草案；接受不等于执行。 */
  readonly acceptedAt: string | null;
};

/**
 * 分配卡冻结的一个 Worker 指派。它覆盖脚本字面量 cli：受限 Execution 中脚本写死的
 * cli/model 不直接生效，只有快照指派决定节点落到哪个已验证 Runtime。
 */
export type WorkerAssignment = {
  /** 目标 Worker 节点 id；必须命中静态枚举的字面量 id，defaultAssignment 的兜底条目除外。 */
  readonly agentId: string;
  /** 分配的 CLI；必须与 runtimeId 对应已验证 Runtime 的 cli 一致。 */
  readonly cli: import("../runtimes/types").RuntimeCli;
  /** 模型分配；本期恒为 "cli-default"（跟随 CLI 默认），模型覆盖尚未验证，不伪造模型目录。 */
  readonly model: "cli-default";
  /** 分配来源：harness-cli=全部用主控 CLI，random=Engine 随机轮换，rule=自然语言规则解析，literal-cli=保留脚本字面量。 */
  readonly source: "harness-cli" | "random" | "rule" | "literal-cli";
  /** 分配目标；必须是 Registry 中已验证的 Runtime。 */
  readonly runtimeId: string;
  /** 分配目标已验证 adapter 标识；创建时与 Registry 核对一致。 */
  readonly adapterId: "codex-acp" | "kimi-acp";
  /** 分配目标已验证 adapter 版本；replay provenance 复核按它比对。 */
  readonly adapterVersion: string;
};

/**
 * 创建 Execution 时由分配卡冻结的不可变执行配置。随 WorkflowExecutionRecord 耐久，
 * resume 从登记事实重新加载；分配变化会让 replay 指纹不匹配，从而诚实拒绝复用旧结果。
 */
export type ExecutionConfigSnapshot = {
  /** 快照格式版本；当前固定为 1。 */
  readonly version: 1;
  /** 快照创建时间。 */
  readonly createdAt: string;
  /** 启动前失败的唯一回退目标：主控 CLI 的 runtimeId；主控不可用则 fail closed。 */
  readonly fallbackRuntimeId: string;
  /** 用户输入的自然语言分配规则原文；未使用规则时为 null。 */
  readonly ruleText: string | null;
  /** 规则解析失败/超时后是否已显式退化为随机分配；UI 必须如实展示。 */
  readonly ruleDegraded: boolean;
  /** 未命中 assignments 的节点（含动态 id Worker）使用的兜底分配。 */
  readonly defaultAssignment: WorkerAssignment;
  /** 逐 Worker 指派；agentId 不得重复。 */
  readonly assignments: readonly WorkerAssignment[];
};

/** 一次 WorkflowExecution 的耐久登记；Execution 内部状态由它自己的 Run Journal 负责。 */
export type WorkflowExecutionRecord = {
  /** Execution 的 UUID，同时是其内嵌 Run Journal 的 runId。 */
  readonly executionId: string;
  /** 绑定的已接受冻结 revision 序号；运行期间不得热修改。 */
  readonly revision: number;
  /** 冻结源码的 SHA-256；恢复时必须与档案内 source.ts 一致。 */
  readonly sourceHash: string;
  /** 创建时的 Runtime 版本；恢复只允许兼容版本继续。 */
  readonly runtimeVersion: number;
  /** 创建时冻结的资源护栏快照；运行中不得扩大。 */
  readonly policy: import("../runtime/policy-host").WorkflowPolicy;
  /** 创建时间。 */
  readonly createdAt: string;
  /** 最近一次已知的内嵌 Run 聚合状态；终态由 execution_finished 固定。 */
  readonly status: "running" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";
  /** 终态时间；未结束时为 null。 */
  readonly finishedAt: string | null;
  /** 终态诊断；正常完成为 null。 */
  readonly diagnostic: string | null;
  /** 脚本 run() 的 JSON 返回值摘要，供主控汇总；非对象结果或未结束时为 null。 */
  readonly summary: JsonObject | null;
  /** 分配卡冻结的执行配置；本期起创建的 Harness Execution 必填，历史档案可缺失。 */
  readonly config?: ExecutionConfigSnapshot;
};

/** 主控经 request_user_decision 发起的用户决策请求；答案只唤醒原工具调用。 */
export type HarnessDecision = {
  /** 稳定决策 id。 */
  readonly decisionId: string;
  /** 面向用户的问题说明。 */
  readonly question: string;
  /** 可选答案 JSON Schema。 */
  readonly answerSchema?: JsonObject;
  /** 请求耐久时间。 */
  readonly createdAt: string;
  /** 已耐久答案；未回答时为 null。 */
  readonly answer: JsonObject | null;
  /** 答案耐久时间。 */
  readonly answeredAt: string | null;
};

/** Pi adapter 向 HarnessService 公开的最小流事件；不暴露 Pi 原始对象。 */
export type HarnessStreamEvent =
  | { readonly type: "reasoning_delta"; readonly delta: string }
  | { readonly type: "assistant_delta"; readonly delta: string }
  /** 当前回合中 MCP 窄工具开始执行；仅供瞬时过程展示，不写入 Harness Journal。 */
  | { readonly type: "tool_started"; readonly toolCallId: string; readonly label: string }
  /** 当前回合中 MCP 窄工具已经结束；成功与否不暴露参数或完整结果。 */
  | { readonly type: "tool_finished"; readonly toolCallId: string; readonly outcome: "completed" | "failed" }
  /** 当前回合已耐久的完整主控消息；只供同一 SSE 回合尾部渲染，不额外持久化。 */
  | { readonly type: "turn_finished"; readonly messageId: string; readonly text: string }
  | { readonly type: "turn_interrupted"; readonly diagnostic: string }
  | { readonly type: "execution_changed"; readonly executionId: string };

/** 用于创建主控会话的本机模型配置；secret 从环境读取，绝不放入此对象。 */
export type HarnessModelConfig = {
  /** OpenAI-compatible 模型名。 */
  readonly model: string;
  /** OpenAI-compatible base URL。 */
  readonly baseUrl: string;
  /** 环境变量名，不是 key 本身。 */
  readonly apiKeyEnv: string;
};
