/** 会话存活探测的三态结果；unknown 绝不能被视为 missing。 */
export type SessionLiveness = "exists" | "missing" | "unknown";

/** SessionBackend 销毁操作的可审计结果。 */
export type DestroyResult = {
  /** destroyed 代表已确认资源不存在；termination-unconfirmed 代表必须保留 identity。 */
  readonly status: "destroyed" | "termination-unconfirmed";
  /** 无法确认终结时的稳定诊断；已销毁时为 null。 */
  readonly diagnostic: string | null;
};

/** 一个受管终端会话的稳定身份；不携带 capability 或业务状态。 */
export type SessionIdentity = {
  /** 当前后端实现名称；P0 固定为 tmux。 */
  readonly backend: "tmux";
  /** 后端内部不透明会话名，不得由 nodeId、Prompt 或 cwd 直接组成。 */
  readonly sessionName: string;
  /** 后端连接坐标；tmux 为 Wave Flow 私有 socket 绝对路径，恢复时必须使用同一坐标。 */
  readonly backendRef: string;
  /** 所属 Wave Flow Run id，用于重新绑定时身份校验。 */
  readonly runId: string;
  /** 所属 Agent 节点 id，用于重新绑定时身份校验。 */
  readonly nodeId: string;
  /** 此次真实终端会话的随机身份，不等同于节点 id。 */
  readonly agentSessionId: string;
  /** 要在会话中运行的正常 CLI 标识；当前仅支持 Codex。 */
  readonly cli: "codex";
  /** 创建时间，用于 Journal、诊断和恢复证据。 */
  readonly createdAt: string;
  /** 可选的耐久 identity 文件坐标；仅 confirmed destroy 后可清理，unknown 时必须保留。 */
  readonly identityFile?: string;
  /** 随机会话标记的 SHA-256；新 daemon 用它比对 Journal 与 tmux identity，绝不保存明文。 */
  readonly reclaimTokenHash?: string;
};

/** 创建具体会话后端资源所需的受控输入。 */
export type CreateSessionOptions = {
  /** 所属 Run id。 */
  readonly runId: string;
  /** 所属 Agent 节点 id。 */
  readonly nodeId: string;
  /** Runtime 已分配的稳定 Agent 会话身份；提供时后端必须原样使用，使 Control、Journal 与终端身份一致。 */
  readonly agentSessionId?: string;
  /** 随机会话标记的 SHA-256；写入 session identity 供新 daemon 验证，明文不落盘。 */
  readonly reclaimTokenHash?: string;
  /** 正常 CLI 标识；当前仅支持 Codex。 */
  readonly cli: "codex";
  /** 已验证的项目内工作目录。 */
  readonly cwd: string;
  /** 待运行命令的 argv；后端必须安全转义，不能直接拼接 shell 文本。 */
  readonly command: readonly string[];
  /** 仅注入该会话的受控环境变量。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 可选 identity 文件绝对路径；提供时后端以原子方式写入 session.json。 */
  readonly identityFile?: string;
};

/** 终端会话后端的统一边界；Runtime、Journal、Control 和 Adapter 不得直接调用具体后端命令。 */
export interface SessionBackend {
  /** 创建 detached 会话并返回经过身份记录的稳定 identity。 */
  create(options: CreateSessionOptions): Promise<SessionIdentity>;
  /** 向会话输入原始文本；成功只代表后端已接收，不代表 CLI 已提交或完成。 */
  sendText(identity: SessionIdentity, text: string): Promise<void>;
  /** 以 bracketed paste 语义粘贴多行文本；不会将其中换行解释为 Enter。 */
  pasteText(identity: SessionIdentity, text: string): Promise<void>;
  /** 向会话发送受控特殊键；当前仅开放 Enter，Adapter 不得注入任意按键序列。 */
  sendSpecialKey(identity: SessionIdentity, key: "Enter"): Promise<void>;
  /** 获取近期终端内容用于诊断；调用方不得从内容推断节点业务状态。 */
  readRecent(identity: SessionIdentity, lines?: number): Promise<string>;
  /** 验证会话存在性和 identity 是否匹配。 */
  liveness(identity: SessionIdentity): Promise<SessionLiveness>;
  /** 断开观察者；不得停止底层终端或 CLI 进程。 */
  detach(identity: SessionIdentity): Promise<void>;
  /** 请求终止会话；只有确认 missing 才能报告 destroyed 并清理 identity。 */
  destroy(identity: SessionIdentity): Promise<DestroyResult>;
}
