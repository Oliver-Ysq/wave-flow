import type { RuntimeCli } from "./types";
import { isCliSelectable } from "../../../src/shared/cli-availability";

/** 单个 CLI 种类的展示元信息。 */
type CliMeta = {
  /** 面向用户的中文界面使用的正式显示名；未知种类不得回退成其它 CLI 的名字。 */
  displayName: string;
  /** 运行时列表图标字母（配合 CSS 类 `runtime-icon ${cli}` 使用）。 */
  icon: string;
};

/**
 * 前端可识别 CLI 的展示元信息查表；与后端 RuntimeCli 联合一一对应。
 * 新增 CLI 时必须在这里登记，任何展示位置不再使用 codex/kimi 三元分支。
 */
const CLI_META: Record<RuntimeCli, CliMeta> = {
  codex: { displayName: "Codex CLI", icon: "C" },
  kimi: { displayName: "Kimi CLI", icon: "K" },
  claude: { displayName: "Claude Code", icon: "A" },
  dsh: { displayName: "DeepSeek Harness", icon: "D" },
};

/** 手动添加下拉框的固定顺序；只展示当前产品可选的 CLI，暂时下线的种类保留元信息但不进入入口。 */
export const CLI_KINDS: readonly RuntimeCli[] = (["codex", "kimi", "claude", "dsh"] as const).filter(isCliSelectable);

/** 按种类取显示名；未知种类显示原值而不是错名字。 */
export function cliDisplayName(cli: RuntimeCli): string {
  return CLI_META[cli]?.displayName ?? cli;
}

/** 按种类取图标字母；未知种类用占位符而不是其它 CLI 的字母。 */
export function cliIcon(cli: RuntimeCli): string {
  return CLI_META[cli]?.icon ?? "?";
}
