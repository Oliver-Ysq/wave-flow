import type { EventSink, WorkflowEvent } from "./types";

export class MemoryEventSink implements EventSink {
  readonly events: WorkflowEvent[] = [];

  emit(event: WorkflowEvent): void {
    this.events.push(event);
  }
}
