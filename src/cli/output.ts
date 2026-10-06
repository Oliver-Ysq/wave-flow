import type { RunSnapshot } from "../runtime/run-types";
import type { CapabilitySnapshot } from "../adapters/capabilities";

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

/** 本机 CLI 帮助；真实 Run 默认通过 App Server 投递并保留 tmux viewer。 */
export const helpText = `wave-flow 本机工作流 CLI

用法:
  wave-flow start
  wave-flow run <workflow.ts> [--input <json>] [--cwd <path>] [--tmux-tui-input]
  wave-flow serve
  wave-flow inspect <run-id>
  wave-flow resume <run-id>
  wave-flow capabilities [--json]
  wave-flow complete --summary <text> --result-file <absolute-json-path> --run-id <id> --node-id <id> --agent-session-id <id>
  wave-flow block --need-help <text> [--answer-schema <json>] --run-id <id> --node-id <id> --agent-session-id <id>
  wave-flow answer <block-request-id> --value <json>
  wave-flow continue --block-request-id <id> --run-id <id> --node-id <id> --agent-session-id <id>

start 确保当前用户的全局 daemon 已启动并健康后立即退出，不创建 Run。
run 默认使用 App Server 的 turn/start ACK 投递首条任务，并保留 tmux 中的 Codex viewer 供人工查看和交互。
--tmux-tui-input 显式使用普通 tmux TUI 的 paste/history 投递兼容路径。
--codex-rpc-input 仍接受，但已是默认行为。`;

/** 渲染人类可读能力摘要；仅显示被当前实现证明的能力。 */
export function formatCapabilities(snapshot: CapabilitySnapshot): string {
  const codex = snapshot.adapters.codex;
  return [
    `平台: ${snapshot.host.platform}`,
    `tmux: ${snapshot.host.tmux.status}`,
    `tmux 持久会话: ${snapshot.host.tmux.persistentSessions}`,
    `Codex 命令: ${codex.status}`,
    `Codex 正常交互会话: ${codex.interactiveSession}`,
    `Codex 已验证 Prompt 投递: ${codex.verifiedPromptDelivery}`,
    `Codex read-only sandbox: ${codex.sandbox.readOnly}`,
    `Codex workspace-write sandbox: ${codex.sandbox.workspaceWrite}`,
  ].join("\n");
}
