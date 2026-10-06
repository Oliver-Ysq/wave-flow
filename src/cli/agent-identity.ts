/** Agent 侧每次 Control 调用显式携带的稳定会话定位信息。不是密码；daemon 还会验证真实会话。 */
export type AgentIdentity = {
  /** 所属 Run。 */
  readonly runId: string;
  /** Agent 节点稳定 id。 */
  readonly nodeId: string;
  /** 本次真实 Agent 会话 id。 */
  readonly agentSessionId: string;
};

/** 从控制命令尾部解析三项稳定身份，拒绝缺失或重复字段。 */
export function parseAgentIdentity(argv: readonly string[]): { readonly identity: AgentIdentity; readonly rest: readonly string[] } {
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag !== "--run-id" && flag !== "--node-id" && flag !== "--agent-session-id") { rest.push(flag); continue; }
    const value = argv[++index];
    if (!value?.trim() || values.has(flag)) throw new Error(`${flag} 必须且只能提供一次。`);
    values.set(flag, value);
  }
  const runId = values.get("--run-id");
  const nodeId = values.get("--node-id");
  const agentSessionId = values.get("--agent-session-id");
  if (!runId || !nodeId || !agentSessionId) throw new Error("受管 Agent 控制命令必须携带 --run-id、--node-id 与 --agent-session-id。");
  return { identity: { runId, nodeId, agentSessionId }, rest };
}

/** 生成任务 Prompt 中可直接复制的显式身份参数；不包含任何 secret。 */
export function renderAgentIdentity(identity: AgentIdentity): string {
  return `--run-id ${identity.runId} --node-id ${identity.nodeId} --agent-session-id ${identity.agentSessionId}`;
}
