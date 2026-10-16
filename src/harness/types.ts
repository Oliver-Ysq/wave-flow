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

/** 工具动作分类；与工具来源分开记录，经 MCP 执行的文件读取仍是 file-read 且保留 MCP 来源。 */
export type HarnessToolKind = "file-read" | "file-write" | "search" | "command" | "mcp" | "unknown";

/** 工具调用来源；engine-mcp 为 Engine 私有 sidecar 窄工具（展示 MCP 徽标），acp 为 CLI 经 ACP 上报的原生调用。 */
export type HarnessToolSource = "engine-mcp" | "acp";

/** 对话条目状态；interrupted 表示回合中断时条目仍未完成，绝不伪装为已完成。 */
export type HarnessConversationEntryStatus = "running" | "completed" | "failed" | "interrupted";

/** 对话条目公共身份字段；条目按回合归属，先耐久后展示。 */
export type HarnessConversationEntryBase = {
  /** 稳定条目 ID；界面 key、流式事件关联与重放去重均使用它。 */
  readonly entryId: string;
  /** 所属回合标识；取该回合用户消息 ID，不要求先存在完整 assistant 消息。 */
  readonly turnId: string;
  /** 回合内单调顺序号，从 1 开始；跨回合不保证连续。 */
  readonly seq: number;
  /** true 表示由 v1-v4 历史档案重建；缺失详情不得补造，界面必须显示“历史记录未保存”。 */
  readonly legacy: boolean;
};

/** assistant 正文条目；中断时保留已发布片段，但 completed=false 不进入权威回答 capsule。 */
export type HarnessBodyEntry = HarnessConversationEntryBase & {
  readonly kind: "body";
  /** 已耐久正文；达到每回合上限后停止追加并以 truncated 标记。 */
  readonly text: string;
  /** 是否为完整回答；false 表示中断残留，不能冒充完整 assistant 消息。 */
  readonly completed: boolean;
  /** 正文因达到保存上限被截断。 */
  readonly truncated: boolean;
  readonly startedAt: string;
  /** 完成或中断时间；进行中为 null。 */
  readonly finishedAt: string | null;
};

/** 思考条目；分离的思考段分别建条目、分别计时，不用整轮耗时冒充思考耗时。 */
export type HarnessThoughtEntry = HarnessConversationEntryBase & {
  readonly kind: "thought";
  /** 已耐久思考正文；达到每回合上限后停止追加并以 truncated 标记。 */
  readonly text: string;
  readonly startedAt: string;
  /** 结束或中断时间；进行中为 null，耗时只能由起止时间计算。 */
  readonly finishedAt: string | null;
  readonly status: "running" | "completed" | "interrupted";
  /** 思考正文因达到保存上限被截断。 */
  readonly truncated: boolean;
};

/** 工具调用条目；记录目标、起止、状态、脱敏参数摘要与限长输出。 */
export type HarnessToolEntry = HarnessConversationEntryBase & {
  readonly kind: "tool";
  /** 稳定调用 ID；Engine 包装器生成或 ACP toolCallId，流式更新按它归并。 */
  readonly callId: string;
  /** 调用来源；engine-mcp 展示 MCP 徽标。 */
  readonly source: HarnessToolSource;
  /** 展示名称；Engine 固定动作名或 ACP title。 */
  readonly name: string;
  /** 动作分类；文件读写/搜索/命令/MCP/未知。 */
  readonly toolKind: HarnessToolKind;
  /** 主要目标：相对路径、命令行或问题摘要；无可靠目标时为 null，不得猜测。 */
  readonly target: string | null;
  /** 允许字段提取并遮蔽已知凭据后的参数摘要；超限截断，不保存完整请求或环境。 */
  readonly paramsSummary: string | null;
  readonly startedAt: string;
  /** 结束或中断时间；进行中为 null，耗时只能由起止时间计算。 */
  readonly finishedAt: string | null;
  readonly status: HarnessConversationEntryStatus;
  /** 限长且脱敏的输出摘录；历史档案或无输出时为 null。 */
  readonly output: string | null;
  /** 输出因达到保存上限被截断；界面不得把已截断内容标为“全部输出”。 */
  readonly outputTruncated: boolean;
  /** 退出码；只有来源明确提供时才存在，不得伪造。 */
  readonly exitCode: number | null;
  /** false 表示历史记录未保存详情（legacy 条目），界面显示占位说明而不是编造内容。 */
  readonly hasDetail: boolean;
};

/** 主控会话的耐久对话条目；重开回放与实时展示同源，全部先写 Journal 再发布。 */
export type HarnessConversationEntry = HarnessBodyEntry | HarnessThoughtEntry | HarnessToolEntry;

/** ACP adapter 归一化后的原生工具调用快照；不泄漏 SDK 原始类型到服务层。 */
export type HarnessAcpToolCall = {
  /** ACP toolCallId，同一调用更新的归并键。 */
  readonly callId: string;
  /** ACP title；无 title 时回退为工具名。 */
  readonly title: string;
  /** 程序化工具名；ACP 允许缺失。 */
  readonly name: string | null;
  /** 由 ACP ToolKind 映射的动作分类；think/switch_mode 已在 adapter 过滤。 */
  readonly toolKind: HarnessToolKind;
  /** ACP 原生状态；pending/in_progress 映射为 running 展示。 */
  readonly status: "pending" | "in_progress" | "completed" | "failed";
  /** 受影响文件位置；取首个作为主要目标。 */
  readonly locations: readonly { readonly path: string; readonly line: number | null }[];
  /** 从 content 提取的文本输出；diff/terminal 以占位摘要表示，不嵌终端流。 */
  readonly contentText: string | null;
  /** ACP rawInput 原值；记录前必须经允许字段提取/脱敏/限长。 */
  readonly rawInput: unknown;
  /** ACP rawOutput 原值；记录前必须经脱敏/限长。 */
  readonly rawOutput: unknown;
};

/** 一个可恢复读取、但不认领原生 Pi session 的主控会话快照。 */
export type HarnessSnapshot = {
  /** 由原Journal派生的执行历史链接；只展示，不授权操作。 */
  readonly executionHistory?:readonly ExecutionHistoryItem[];
  /** 此档案已应用事件数；用于展示快照防倒退，不是业务授权。 */
  readonly snapshotSequence?: number;
  /** Engine 当前活跃执行待答计数；只作轻量展示，历史缺省，不包含节点内容或授权。 */
  readonly executionAttention?: Readonly<Record<string,{readonly workerRequests:number;readonly scriptGates:number}>>;
  /** 自动编排元数据；历史 Harness 缺省，不补造卡身份。 */
  readonly task?: import("./task-contract").TaskMetadata;
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
  /** 按回合归属的耐久对话条目（正文/思考/工具）；实时展示与重开回放同源于此。 */
  readonly conversationEntries: readonly HarnessConversationEntry[];
  /** 已耐久的 Workflow 草案；接受仅冻结 revision，不代表已创建或执行 Worker Run。 */
  readonly workflowRevisions: readonly WorkflowRevision[];
  /** 本 Harness 顺序拥有的 WorkflowExecution 登记；执行细节在 Execution 自己的 Run Journal。 */
  readonly executions: readonly WorkflowExecutionRecord[];
  /** 主控发起的用户决策请求；答案经独立 API 耐久，不经过回合 mutation 锁。 */
  readonly decisions: readonly HarnessDecision[];
};

/** 聊天执行历史的稳定投影，不复制节点权威状态。 */
export type ExecutionHistoryItem={
  /** 同一档案内稳定事件键。 */
  readonly key:string;
  /** 原保存时间。 */
  readonly at:string;
  /** 原执行身份。 */
  readonly executionId:string;
  /** 原冻结版本。 */
  readonly revision:number;
  /** 原尝试号；历史未知时缺省。 */
  readonly attempt?:number;
  /** 原事件类型。 */
  readonly kind:"created"|"finished";
  /** 事件当时状态，不随最新执行变化。 */
  readonly status:WorkflowExecutionRecord["status"];
  /** 原终态诊断，创建事件为null。 */
  readonly diagnostic:string|null;
  /** 原终态返回值，创建或无结果为null；不套最新结果。 */
  readonly summary:JsonObject|null;
};

/** 主控会话中的不可变 workflow.ts 草案。 */
export type WorkflowRevision = {
  /** 受信任本地来源快照；缺省为受限源码；只由Engine安全预检写入，主控不能提交。 */
  readonly localOrigin?: {
    /** 已验证项目内原文件；恢复不再次读取它。 */ readonly path: string;
    /** 原预检源码hash，须等于revision.sourceHash。 */ readonly sourceHash: string;
    /** 静态元数据，不通过执行模块获取。 */ readonly meta: import("../shared/workflow-types").WorkflowMeta;
    /** 冻结业务输入对象Schema。 */ readonly inputSchema: JsonObject;
  };
  /** 参数待补齐的准备态；完整Schema验证前不能批准/执行，默认false。 */
  readonly parametersPending?:boolean;
  /** 保存请求 UUID；同请求同载荷重试返回原版本，异载荷拒绝。 */
  readonly saveRequestId?: string;
  /** 保存请求的规范载荷指纹，用于重试冲突检测，不是权限凭据。 */
  readonly savePayloadHash?: string;
  /** 内置模板的不可变目录快照；缺省为主控生成源码，不从 meta 推断来源。 */
  readonly templateOrigin?: import("./workflow-templates").TemplateOrigin;
  /** 模板派生 generated 版本的原始来源；不赋予原模板启动资格。 */
  readonly derivedFrom?: import("./workflow-templates").TemplateOrigin;
  /** 此版本已校验的业务参数；模板保存后重开恢复，变更须追加版本并重新批准。 */
  readonly input?: JsonObject;
  /** 准备过程的稳定 UUID；历史版本缺省。 */
  readonly cardId?: string;
  /** 同卡前一版本；首版为 null。 */
  readonly parentRevision?: number | null;
  /** 版本目标，不从 Task 首条消息推断。 */
  readonly goal?: string;
  /** 人类可读工作范围。 */
  readonly scope?: string;
  /** 整卡放弃时间；批准证据保持不变。 */
  readonly abandonedAt?: string | null;
  /** 提案所属主控回合消息。 */
  readonly turnId?: string;
  /** 耐久展示预览；旧档案缺省，Engine 首次加载时补算保存，不作为执行授权。 */
  readonly preview?: import("./revision-preview").RevisionPreview;
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
  /** 用户明确拒绝此草案的时间；拒绝是不可逆耐久事实，已拒绝草案不能再接受。历史档案无此字段时按 null 处理。 */
  readonly rejectedAt?: string | null;
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
  /** 分配来源：harness-cli=跟随主控，user=用户在Workflow设计内选择；历史值兼容读取。 */
  readonly source: "harness-cli" | "user" | "random" | "rule" | "literal-cli";
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
  /** 来源控制路由；历史缺省restricted-execution；local-run使用独立Run Store，不变更源码信任。 */
  readonly kind?: "restricted-execution" | "local-run";
  /** 模板确认请求 UUID；缺省为历史/自动编排执行，同请求重试不再次派发。 */
  readonly confirmationRequestId?: string;
  /** 确认版本/输入/配置规范指纹；只用于冲突检测，不构成授权。 */
  readonly confirmationPayloadHash?: string;
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
  /** 受限来源冻结的分配配置；本地来源不保存也不使用，历史受限档案可缺失但不能恢复。 */
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
export type HarnessStreamEvent = (
  | { readonly type: "reasoning_delta"; readonly delta: string }
  | { readonly type: "assistant_delta"; readonly delta: string }
  /** 当前回合中 MCP 窄工具开始执行；仅供瞬时过程展示，不写入 Harness Journal。 */
  | { readonly type: "tool_started"; readonly toolCallId: string; readonly label: string }
  /** 当前回合中 MCP 窄工具已经结束；成功与否不暴露参数或完整结果。 */
  | { readonly type: "tool_finished"; readonly toolCallId: string; readonly outcome: "completed" | "failed" }
  /** ACP 原生工具调用开始；由 adapter 归一化，服务层据此建立耐久工具条目。 */
  | { readonly type: "acp_tool_call"; readonly call: HarnessAcpToolCall }
  /** ACP 原生工具调用更新；按 callId 归并到既有耐久条目。 */
  | { readonly type: "acp_tool_update"; readonly callId: string; readonly patch: HarnessAcpToolCallPatch }
  /** 耐久对话条目已建立（先写 Journal 成功后发布）；界面据此立即渲染“运行中”。 */
  | { readonly type: "entry_started"; readonly entry: HarnessConversationEntry }
  /** 耐久对话条目追加正文/输出（先写 Journal 成功后发布）；text 为本次追加片段。 */
  | { readonly type: "entry_appended"; readonly entryId: string; readonly text: string; readonly truncated: boolean }
  /** 耐久对话条目已终结（先写 Journal 成功后发布）；携带完整最终条目。 */
  | { readonly type: "entry_finished"; readonly entry: HarnessConversationEntry }
  /** 当前回合已耐久的完整主控消息；只供同一 SSE 回合尾部渲染，不额外持久化。 */
  | { readonly type: "turn_finished"; readonly messageId: string; readonly text: string }
  | { readonly type: "turn_interrupted"; readonly diagnostic: string }
  | { readonly type: "execution_changed"; readonly executionId: string }) & {/** 对应已应用档案事件数；原生未耐久事件缺省。 */ readonly snapshotSequence?:number};

/** ACP 工具调用增量补丁；仅携带发生变化的字段（可变形状，便于 adapter 逐项组装）。 */
export type HarnessAcpToolCallPatch = { -readonly [K in keyof Omit<HarnessAcpToolCall, "callId">]?: HarnessAcpToolCall[K] };

/** 用于创建主控会话的本机模型配置；secret 从环境读取，绝不放入此对象。 */
export type HarnessModelConfig = {
  /** OpenAI-compatible 模型名。 */
  readonly model: string;
  /** OpenAI-compatible base URL。 */
  readonly baseUrl: string;
  /** 环境变量名，不是 key 本身。 */
  readonly apiKeyEnv: string;
};
