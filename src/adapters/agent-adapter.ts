/** Runtime 交给执行器的任务边界，Adapter 决定如何真正执行它。 */
export type AgentExecutionInput = {
  /** Runtime 原样转交给 Adapter 的任务说明。 */
  prompt: string;
  /** 节点稳定名称，用于 Adapter 日志及将来的子进程、Journal 文件命名。 */
  label: string;
  /** Agent 应视为工作目录的绝对路径；未来写入模式会更严格地校验它。 */
  cwd: string;
};

/**
 * 可替换的 Agent 后端。当前测试使用 FakeAgentAdapter，后续会增加 Codex CLI 实现。
 */
export type AgentAdapter = {
  /**
   * 将 Runtime 描述的一次任务实际执行完成。
   * @param input 规范化后的 prompt、label 和 cwd。
   * @returns 至少包含最终输出；未来会增加 usage、原始事件和结构化输出。
   * @throws 执行器无法启动、Agent 失败或结果不合法时抛出。
   */
  execute(input: AgentExecutionInput): Promise<{ output: string }>;
};
