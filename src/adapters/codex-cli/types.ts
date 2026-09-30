/** Codex `--json` stdout 中首切片需要识别的最小事件形状。未知事件会被忽略。 */
export type CodexJsonEvent = {
  /** Codex 事件类别，例如 `item.completed` 或 `turn.completed`。 */
  type: string;
  /** item.completed 的载荷；只在 item.type 为 agent_message 时读取 text。 */
  item?: {
    /** Codex 产物类别；当前只消费 agent_message。 */
    type?: string;
    /** Agent 最终消息文本。 */
    text?: string;
  };
  /** turn.completed 的可选用量；首切片不暴露到公共 AgentResult。 */
  usage?: Record<string, number>;
};

/** 一次 Codex 子进程完成后的原始证据，供 Adapter 决定成功或失败。 */
export type CodexProcessResult = {
  /** 流式解析 stdout 后保留的最后一条 agent_message；不会保留完整 JSONL。 */
  finalMessage?: string;
  /** stdout 中遇到的第一条 JSONL 解析错误；进程收尾后再由 Adapter 决定如何报告。 */
  stdoutParseError?: string;
  /** 子进程 stderr；只用于有限诊断，不能按 JSONL 解析。 */
  stderr: string;
  /** 系统进程退出码，0 表示 Codex 正常完成。 */
  exitCode: number;
};
