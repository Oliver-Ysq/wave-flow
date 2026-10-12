import type { RunSnapshot } from "../runtime/run-types";

/** 渲染用户可读的 Phase → Agent Run 查询结果。 */
export function formatSnapshot(snapshot: RunSnapshot): string {
  const lines = [`RunId: ${snapshot.id}`, `状态: ${snapshot.status}`, `Workflow: ${snapshot.workflow.name}`];
  for (const phase of snapshot.phases) {
    lines.push(`阶段: ${phase.title}`);
    for (const agent of phase.agents) {
      const block = agent.block ? `  block=${agent.block.blockRequestId}${agent.block.answered ? "（已回答，等待 Agent continue）" : ""}  ${agent.block.needHelp}` : "";
      lines.push(`  ${agent.status}  ${agent.id}${agent.result ? `  ${JSON.stringify(agent.result)}` : ""}${agent.diagnostic ? `  ${agent.diagnostic}` : ""}${block}`);
    }
  }
  return lines.join("\n");
}

/** 本机 CLI 帮助；真实 Run 默认通过 Codex ACP Worker 执行。 */
export const helpText = `wave-flow 本机工作流 CLI

用法:
  wave-flow start
  wave-flow run <workflow.ts> [--input <json>] [--cwd <path>]
  wave-flow serve
  wave-flow web
  wave-flow close
  wave-flow close
  wave-flow inspect <run-id>
  wave-flow pause <run-id>
  wave-flow recover <run-id>
  wave-flow stop <run-id>
  wave-flow resume <run-id>
  wave-flow complete --summary <text> --result-file <absolute-json-path> --run-id <id> --node-id <id> --agent-session-id <id>
  wave-flow block --need-help <text> [--answer-schema <json>] --run-id <id> --node-id <id> --agent-session-id <id>
  wave-flow answer <block-request-id> --value <json>
  wave-flow continue --block-request-id <id> --run-id <id> --node-id <id> --agent-session-id <id>

start 确保当前用户的全局 daemon 已启动并健康后立即退出，不创建 Run。
close 只关闭已通过 descriptor、PID 启动身份与 /health 验证的当前用户 daemon；不会盲目终止 PID。
web 会显示 daemon 的发现、启动或复用、health 验证过程，然后输出同源 Local Web 地址。
run 仅使用用户选择并验证的 Codex ACP Worker；Worker 具有 workflow 指派的完整读写执行权限。`;
