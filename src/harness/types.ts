import type { JsonObject } from "../shared/json";

/** Harness 会话的耐久状态；它不等同于 Workflow Run 完成状态。 */
export type HarnessStatus = "idle" | "running" | "interrupted";

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
  /** 创建时间。 */
  readonly createdAt: string;
  /** 当前已耐久的完整消息。 */
  readonly messages: readonly HarnessMessage[];
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
  | { readonly type: "turn_finished"; readonly messageId: string }
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
