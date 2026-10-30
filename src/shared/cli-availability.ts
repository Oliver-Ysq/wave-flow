import type { RuntimeCli } from "../runtimes/types";

/**
 * 暂时从产品入口下线的 CLI 种类。
 *
 * 语义：Adapter、类型、隔离代码与历史 Journal 全部保留，但扫描、验证、列表、
 * 默认主控、Worker 分配与启动复核都拒绝这些 CLI。恢复时只需从这里移除并重新
 * 验收；Web 与 Engine 共用本清单，禁止在界面维护第二份名单。
 */
export const TEMPORARILY_UNAVAILABLE_CLIS: ReadonlySet<RuntimeCli> = new Set<RuntimeCli>(["kimi"]);

/** 面向用户的 CLI 名称；只用于错误文案，不参与任何能力判定。 */
const CLI_LABELS: Readonly<Record<RuntimeCli, string>> = {
  codex: "Codex CLI",
  kimi: "Kimi CLI",
  claude: "Claude Code",
  dsh: "DeepSeek Harness",
};

/**
 * 该 CLI 是否可在当前产品入口中被发现、选择、分配或启动。
 *
 * 返回 false 表示“支持已暂时下线”，不是“安装缺失”。调用方必须 fail closed，
 * 不得回退到其他 CLI、删除历史记录或静默忽略。
 */
export function isCliSelectable(cli: RuntimeCli): boolean {
  return !TEMPORARILY_UNAVAILABLE_CLIS.has(cli);
}

/**
 * 不可用原因的稳定中文文案；可选 CLI 返回 null。
 *
 * 文案不包含内部路径、capability、FIFO 或环境变量，可安全展示给用户与写入诊断。
 */
export function cliUnavailableReason(cli: RuntimeCli): string | null {
  if (isCliSelectable(cli)) return null;
  return `${CLI_LABELS[cli]} 支持已暂时下线：历史记录仍可查看，但不能新建执行、恢复或重新派发。 `;
}

/** 按 RuntimeCli 取稳定中文显示名；未知值回退为原值，避免 UI 显示错误 CLI 名。 */
export function cliDisplayLabel(cli: RuntimeCli): string {
  return CLI_LABELS[cli] ?? cli;
}

/** 校验任意输入是否为受支持的 CLI 标识；不接受大小写变体、别名或未知值。 */
export function isRuntimeCli(value: unknown): value is RuntimeCli {
  return value === "codex" || value === "kimi" || value === "claude" || value === "dsh";
}
