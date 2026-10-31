import { AsyncLocalStorage } from "node:async_hooks";

/** Task 短事务仲裁；模型回合与人工等待不得保持 active 租约。 */
export class TaskLifecycle {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly context = new AsyncLocalStorage<{ id: string; active: boolean }>();
  /** 后台模型/运行任务脱离短事务上下文，禁止通过继承租约绕过串行。 */
  outside<T>(operation: () => T): T { return this.context.exit(operation); }
  /** 同任务串行，事务内服务调用可重入；释放后的回调重新排队。 */
  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current?.id === id && current.active) return operation();
    const previous = this.queues.get(id) ?? Promise.resolve();
    const lease = { id, active: true };
    const task = previous.catch(() => {}).then(() => this.context.run(lease, async () => {
      try { return await operation(); } finally { lease.active = false; }
    }));
    const settled = task.then(() => {}, () => {});
    this.queues.set(id, settled);
    try { return await task; } finally { if (this.queues.get(id) === settled) this.queues.delete(id); }
  }
}
