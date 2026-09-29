import type { EventSink, WorkflowEvent } from "./types";

/** 当前阶段和测试使用的内存事件收集器，生产 CLI 会另行实现 JSONL EventSink。 */
export class MemoryEventSink implements EventSink {
  /** 按发生时间保存的事件列表；主要供测试断言，不应用作持久化运行记录。 */
  readonly events: WorkflowEvent[] = [];

  /** @param event Runtime 刚刚发生的生命周期事实；不会修改 event 或重新排序。 */
  emit(event: WorkflowEvent): void {
    this.events.push(event);
  }
}
