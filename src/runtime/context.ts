import type { WorkflowContext } from "../workflow/types";
import type { AgentOptions, AgentResult, RuntimeOptions } from "./types";

/**
 * 为一次 Workflow 运行创建受控上下文。
 * Runner 负责整次运行的开始、结束和错误边界；这个模块专门实现 Workflow 可调用的
 * 原语，避免 runner.ts 随着 parallel、pipeline、phase 等 API 增长而失去焦点。
 *
 * @param options Runner 创建时提供的 Adapter、事件输出和工作目录。
 * @param runId 当前整次 Workflow 的唯一标识。
 * @returns 仅暴露 WorkflowContext 协议中允许调用的方法。
 */
export function createWorkflowContext(options: RuntimeOptions, runId: string): WorkflowContext {
  /**
   * 统一封装一次 Agent 调用，确保无论从 Workflow 直接调用还是从 parallel 中调用，
   * 都遵循相同的事件和 Adapter 委派规则。
   */
  async function agent(prompt: string, agentOptions: AgentOptions = {}): Promise<AgentResult> {
    const label = agentOptions.label ?? "agent";
    options.events.emit({ type: "agent.started", runId, label, prompt });
    try {
      const result = await options.adapter.execute({ prompt, label, cwd: options.cwd });
      options.events.emit({ type: "agent.completed", runId, label });
      // 尚未实现 Journal；结果均来自本次执行，因而 replayed 固定为 false。
      return { output: result.output, replayed: false, runId };
    } catch (error) {
      // 节点级失败必须先记录，Runner 才能在外层补充整次 workflow.error。
      options.events.emit({
        type: "agent.failed",
        runId,
        label,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    agent,
    async parallel<T>(tasks: Array<() => Promise<T>>): Promise<Array<T | null>> {
      /**
       * 先同步建立所有 Promise，再统一等待。这样前一个慢任务不会阻塞后一个任务的启动，
       * 从而形成真正的并行屏障，而不是串行 for-await 循环。
       * Promise.resolve().then(task) 也会将“任务刚调用就同步抛错”归为单项失败。
       */
      const settled = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));

      // allSettled 的输出顺序与输入 tasks 严格一致；失败项降级为 null，不影响兄弟任务。
      return settled.map((result) => (result.status === "fulfilled" ? result.value : null));
    },
  };
}
