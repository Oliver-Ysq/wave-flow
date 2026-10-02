import type { RunSnapshot } from "../runtime/run-types";

/** 渲染用户可读的 Phase → Agent Run 查询结果。 */
export function formatSnapshot(snapshot: RunSnapshot): string {
  const lines = [`RunId: ${snapshot.id}`, `状态: ${snapshot.status}`, `Workflow: ${snapshot.workflow.name}`];
  for (const phase of snapshot.phases) {
    lines.push(`阶段: ${phase.title}`);
    for (const agent of phase.agents) lines.push(`  ${agent.status}  ${agent.id}${agent.result ? `  ${JSON.stringify(agent.result)}` : ""}${agent.diagnostic ? `  ${agent.diagnostic}` : ""}`);
  }
  return lines.join("\n");
}

/** 4.1 CLI 帮助；明确该路径不启动真实 Coding Agent。 */
export const helpText = `wave-flow 开发验证 CLI

用法:
  wave-flow run <workflow.ts> [--input <json>] [--cwd <path>]
  wave-flow inspect <run-id> [--cwd <path>]

当前 run 使用确定性开发验证执行器，不启动 tmux、Codex 或其他真实 Agent。`;
