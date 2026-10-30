import type { JsonObject } from "../shared/json";

/** Harness 会话的耐久状态；它不等同于 Workflow Run 完成状态。 */
export type HarnessStatus = "idle" | "running" | "interrupted" | "completed";

/** 与用户消息耐久绑定的附件元数据；字节保存在 Harness 档案目录的私有文件中。 */
export type HarnessMessageAttachment = {
  /** 附件稳定 id（即暂存 UUID）；路径只使用它，不使用用户文件名。 */
  readonly id: string;
  /** 原文件名；仅展示，不作为路径。 */
  readonly name: string;
  /** 经 magic bytes 复核的 MIME；首版仅 image/png、image/jpeg、image/gif、image/webp。 */
  readonly mimeType: string;
  /** 字节数；重开复核文件大小必须一致。 */
  readonly sizeBytes: number;
  /** 内容 SHA-256；发送绑定前复核。 */
  readonly sha256: string;
  /** 相对 Harness 档案目录的安全相对路径（attachments/<messageId>/<attachmentId>）。 */
  readonly file: string;
};

/** 用户或完整主控消息；reasoning delta 永不进入此类型。 */
export type HarnessMessage = {
  /** 自动总结义务键；缺省为普通对话，不伪造用户消息。 */
  readonly summaryKey?: string;
  /** 稳定消息标识，用于界面 key 与分页去重。 */
  readonly id: string;
  /** 消息来源；assistant 只在完整文本耐久后出现。 */
  readonly role: "user" | "assistant";
  /** 可展示的正文；不得包含模型 key 或未完成 reasoning。 */
  readonly text: string;
  /** 与消息同生死的附件；只有经 Adapter 能力验证后才会绑定。 */
  readonly attachments?: readonly HarnessMessageAttachment[];
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

/** 主控忙碌时耐久排队的用户消息；只有 Engine 派发或用户取消才能离开队列。 */
export type HarnessQueuedMessage = {
  /** 排队用户消息；id 在消息与队列全局唯一，客户端可携带以去重重试。 */
  readonly message: HarnessMessage;
  /** true 表示用户选择“立即发送”；派发顺序优先于普通排队消息，且需先中断当前回合。 */
  readonly priority: boolean;
  /** 耐久入队时间；同优先级内按它严格 FIFO。 */
  readonly queuedAt: string;
};

/** 一个可恢复读取、但不认领原生 Pi session 的主控会话快照。 */
export type HarnessSnapshot = {
  /** 耐久 FIFO 消息队列；普通消息在主控忙碌时入队，回合正常结束后按序自动投递。 */
  readonly messageQueue: readonly HarnessQueuedMessage[];
  /** 耐久影响面总结义务；旧档案缺省，不补造历史。 */
  readonly impactSummaries?: readonly ImpactSummary[];
  /** 由原Journal派生的执行历史链接；只展示，不授权操作。 */
  readonly executionHistory?:readonly ExecutionHistoryItem[];
  /** 此档案已应用事件数；用于展示快照防倒退，不是业务授权。 */
  readonly snapshotSequence?: number;
  /** 当前 ACP 会话广告的斜杠命令/技能；仅内存态，不进入 Journal。缺省表示尚无会话或尚未收到目录。 */
  readonly availableCommands?: readonly HarnessAvailableCommand[];
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
  /** 最终确认在准备版本前冻结的请求摘要；历史缺省为空，重试不能更换载荷。 */
  readonly executionConfirmations?: readonly ExecutionConfirmation[];
  /** 主控发起的用户决策请求；答案经独立 API 耐久，不经过回合 mutation 锁。 */
  readonly decisions: readonly HarnessDecision[];
};

/** 最终确认的耐久收据；不代表Execution已关联或允许后台自动投递。 */
export type ExecutionConfirmation = {
  /** 用户确认UUID，同Task内唯一。 */ readonly requestId: string;
  /** 确认展示的正整数版本，准备参数版本时仍保持原值。 */ readonly revision: number;
  /** 版本、输入、配置及现场证据的SHA-256。 */ readonly payloadHash: string;
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

/** 终态事件同时建立的总结义务；完整回答及回合终结耐久后才完成。 */
export type ImpactSummary = {
  /** 总结使用的现场证据SHA-256；缺省为尚未绑定，不能作为最新现场批准。 */
  readonly evidenceHash?: string;
  /** 现场补充绑定原总结key；缺省为原终态总结，原回答不改写。 */
  readonly supplementOf?: string;
  /** 过时且未完成的现场补充由哪个证据义务替代；缺省仍有效，保留原状态/诊断历史。 */
  readonly supersededBy?: string;
  /** 最新总结回合的唯一身份；旧记录缺省使用summary:key，重试不复用过程身份。 */
  readonly turnId?: string;
  /** Task/execution/attempt/终态事实确定性 SHA-256，不是授权秘密。 */
  readonly key: string;
  /** 所属 Execution；读取再校验 Task。 */
  readonly executionId: string;
  /** 原 Runtime 正整数 attempt。 */
  readonly attempt: number;
  /** pending 待安排、running 回合中、interrupted 须重试、completed 完整耐久、cancelled 仅明确放弃且同时归档。 */
  readonly status: "pending" | "running" | "interrupted" | "completed" | "cancelled";
  /** 原终态时间。 */
  readonly createdAt: string;
  /** 完整回答时间；未完成 null。 */
  readonly completedAt: string | null;
  /** 完整回答消息 ID；未完成 null。 */
  readonly messageId: string | null;
  /** 中断原因；无中断 null。 */
  readonly diagnostic: string | null;
};

/** 主控会话中的不可变 workflow.ts 草案。 */
export type WorkflowRevision = {
  /** 保存入口记录的更新原因；缺省为旧记录未知。仅用于展示，不改变批准/执行语义。 */
  readonly updateReason?: "save-template" | "save-local" | "generate-plan" | "modify-plan" | "modify-parameters" | "modify-configuration";
  /**
   * 源码形态；module 为作者模块，restricted 为升级前的受限方言。
   * 缺省时按 localOrigin 是否存在推断：有 localOrigin 视为 module，否则视为 restricted。
   */
  readonly sourceFormat?: "module" | "restricted";
  /** 保存并接管的请求 UUID；仅由用户保存生成的 revision 有，用于同请求幂等。 */
  readonly exportRequestId?: string;
  /** 保存并接管的耐久时间；仅由用户保存生成的 revision 有。 */
  readonly exportedAt?: string;
  /** 保存并接管的规范载荷指纹；同一 UUID 冲突检测，不构成授权。 */
  readonly exportPayloadHash?: string;
  /** 本地来源快照；只由Engine安全预检写入或用户保存接管写入，主控不能提交。 */
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
  /** 草案 TypeScript 原文；module 形态为作者模块，restricted 为旧格式。 */
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
 * 历史 assigned 配置中的一个 Worker 指派。模块 Workflow 不使用该字段，
 * 节点 cli/model 由作者源码直接决定。
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
  readonly adapterId: "codex-acp" | "kimi-acp" | "claude-acp" | "dsh-acp";
  /** 分配目标已验证 adapter 版本；replay provenance 复核按它比对。 */
  readonly adapterVersion: string;
};

/**
 * 创建 Execution 时冻结的不可变执行配置。随 WorkflowExecutionRecord 耐久，
 * resume 从登记事实重新加载。assigned 模式由分配卡决定节点 CLI；
 * script 模式由作者模块自己决定 CLI/模型，配置只承载工作区授权。
 */
export type ExecutionConfigSnapshot =
  | {
      /** 快照格式版本；当前固定为 1。 */
      readonly version: 1;
      /** 分配模式；缺省 assigned 兼容旧记录。 */
      readonly assignmentMode?: "assigned";
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
      /** Wave Flow新增Git成果授权与绑定；省略仅允许无受管写成果的既有路径，不隐式创建worktree/commit。 */
      readonly workspaces?: import("../workspace/execution-workspaces").ExecutionWorkspaceConfig;
    }
  | {
      /** 快照格式版本；当前固定为 1。 */
      readonly version: 1;
      /** 脚本模式：每个节点优先取作者字面量 cli，省略时取本次执行按节点选择的结果。 */
      readonly assignmentMode: "script";
      /** 快照创建时间。 */
      readonly createdAt: string;
      /**
       * 逐节点 CLI 选择：键是源码中省略 `cli` 的字面量节点 id，值是本次执行选定的 CLI。
       *
       * 与主控生成稿"每个节点各自声明 CLI"的语义对齐：同一份预置里两个节点可以分别跑在
       * 不同 CLI 上。作者写死的 cli 优先，不会被这里的条目覆盖；未列出的字面量节点会回落到
       * `cli`（若存在），否则在任何 Worker 启动前以契约错误拒绝。值必须是本机已验证的 CLI，
       * 并随 Journal 生效请求与 Replay 指纹参与复用判定。
       */
      readonly nodeClis?: Readonly<Record<string, import("../runtimes/types").RuntimeCli>>;
      /**
       * 动态节点的兜底 CLI；只用于无法静态枚举 id 的 `agent()` 调用（循环/变量 id）。
       *
       * 静态节点应优先用 `nodeClis` 逐节点选择；`cli` 只为"名单外的节点"（含动态节点）兜底。
       */
      readonly cli?: import("../runtimes/types").RuntimeCli;
      /** 仅写类模块 Workflow 需要；只读模块不带此字段。 */
      readonly workspaces?: import("../workspace/execution-workspaces").ExecutionWorkspaceConfig;
    };

/** 一次 WorkflowExecution 的耐久登记；Execution 内部状态由它自己的 Run Journal 负责。 */
export type WorkflowExecutionRecord = {
  /** 前一终态Execution的启动现场证据；首次缺省，确认时冻结，不作为跨执行Replay或权限。 */
  readonly sceneEvidenceHash?:string;
  /**
   * 来源控制路由：module-run 为生成模块，local-run 为本地来源文件，
   * restricted-execution 为历史只读记录。local-run 使用独立 Run Store；其余使用 Harness 内嵌 Store。
   */
  readonly kind?: "module-run" | "local-run" | "restricted-execution";
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
  /** 历史 assigned 配置或模块写类的工作区授权；模块只读执行不保存，旧受限档案缺省即不可恢复。 */
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

/** 当前 ACP 主控会话广告的斜杠命令/技能；仅内存态，不进入 Journal。 */
export type HarnessAvailableCommand = {
  /** Agent 提供的原始命令名；Codex 技能以 `$` 开头，其他 CLI 可能是普通名称。 */
  readonly name: string;
  /** Agent 提供的一行说明；超长时由展示层截断。 */
  readonly description: string;
  /** 命令参数提示；无参数时为 null。 */
  readonly inputHint: string | null;
};

/** Pi adapter 向 HarnessService 公开的最小流事件；不暴露 Pi 原始对象。 */
export type HarnessStreamEvent = (
  | { /** 最终标题耐久后通知UI重读，不携带生成过程。 */ readonly type:"title_changed" }
  | { readonly type: "reasoning_delta"; readonly delta: string }
  | { readonly type: "assistant_delta"; readonly delta: string }
  /** 当前 ACP 会话广告的斜杠命令/技能集合；界面用于斜杠菜单，不写入 Journal。 */
  | { readonly type: "commands_changed"; readonly commands: readonly HarnessAvailableCommand[] }
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
  /** 耐久消息队列已变化（入队/取消/派发）；界面据此重读快照，不携带队列内容。 */
  | { readonly type: "queue_changed" }
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
