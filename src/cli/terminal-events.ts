import type { EventSink, WorkflowEvent } from "../events/types";

/** 可替换的文本输出函数；注入它可让终端输出在测试中无需依赖 console。 */
export type TerminalWriter = (line: string) => void;

/**
 * 将既有 WorkflowEvent 翻译为人类容易扫读的终端进度。
 * 它不创建事件、不改变事件顺序；未来 --print 只需提供另一种 EventSink 实现。
 */
export class TerminalEventSink implements EventSink {
  /** @param write 默认使用 console.log；测试可传入数组收集函数。 */
  constructor(private readonly write: TerminalWriter = console.log) {}

  /** @param event Runner 发出的生命周期事实。 */
  emit(event: WorkflowEvent): void {
    switch (event.type) {
      case "workflow.start":
        this.write(`▶ Workflow started: ${event.workflow}`);
        this.write(`  Run ID: ${event.runId}`);
        break;
      case "agent.started":
        this.write(`  → Agent started: ${event.label}`);
        break;
      case "agent.completed":
        this.write(`  ✓ Agent completed: ${event.label}`);
        break;
      case "workflow.end":
        this.write(`✓ Workflow completed: ${event.workflow}`);
        break;
      case "workflow.error":
        this.write(`✗ Workflow failed: ${event.workflow}`);
        this.write(`  ${event.error}`);
        break;
    }
  }
}
