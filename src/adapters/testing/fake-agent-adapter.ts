import type { AgentAdapter, AgentExecutionInput } from "../agent-adapter";

/**
 * 单元测试用的确定性执行器：不启动模型或子进程，只记录输入并返回预设文本。
 */
export class FakeAgentAdapter implements AgentAdapter {
  /** Runtime 已委派的所有输入，按调用先后保存，供测试断言。 */
  readonly calls: AgentExecutionInput[] = [];

  /** @param response 每次 execute 都要返回的固定最终文本。 */
  constructor(private readonly response: string) {}

  /** @param input Runtime 规范化后的 Agent 任务。@returns 不执行真实 Agent 的模拟结果。 */
  async execute(input: AgentExecutionInput): Promise<{ output: string }> {
    this.calls.push(input);
    return { output: this.response };
  }
}
