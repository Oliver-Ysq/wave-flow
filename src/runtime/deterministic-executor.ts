import type { JsonObject } from "../shared/json";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";

/** 仅供自动测试注入的确定性执行器；不创建 CLI、进程或会话。 */
export class DeterministicExecutor implements AgentNodeExecutor {
  /** 返回稳定 JSON 结果，验证 Runtime、Journal 和 inspect 链路。 */
  async execute(node: AgentNodeSnapshot): Promise<JsonObject> {
    return { nodeId: node.id, summary: `开发验证节点已完成：${node.label}` };
  }
}
