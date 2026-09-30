/** 运行过程的最小事实记录；后续终端 UI、JSONL Writer 和 Journal 将共享这套事件。 */
export type WorkflowEvent =
  /** 整个 Workflow 已通过预检并即将执行；workflow 是 meta.name。 */
  | { type: "workflow.start"; runId: string; workflow: string }
  /** 单个 Agent 即将委派给 Adapter；prompt 会参与未来的回放键计算。 */
  | { type: "agent.started"; runId: string; label: string; prompt: string }
  /** Adapter 成功返回最终输出。 */
  | { type: "agent.completed"; runId: string; label: string }
  /** Adapter 执行失败；label 用于定位失败节点，error 保留面向人类的诊断信息。 */
  | { type: "agent.failed"; runId: string; label: string; error: string }
  /** Workflow 的 run 函数已正常返回。 */
  | { type: "workflow.end"; runId: string; workflow: string }
  /** Workflow 或其 Agent 抛出未处理错误；error 是面向人类的错误文本。 */
  | { type: "workflow.error"; runId: string; workflow: string; error: string };

/** 事件消费端抽象，使 Runtime 不依赖事件最终写到内存、终端还是文件。 */
export type EventSink = {
  /** @param event Runtime 按发生顺序发出的不可变事实。 */
  emit(event: WorkflowEvent): void;
};
