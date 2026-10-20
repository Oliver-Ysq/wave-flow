const STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: "排队中",
  running: "工作中",
  blocked: "需要协助",
  pausing: "暂停中",
  paused: "已暂停",
  recovering: "恢复中",
  completed: "已完成",
  cancelled: "已停止",
  interrupted: "已中断",
};

/** 工作台与团队面板的既有状态文案；未知状态原样展示，不推断或改变业务状态。 */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
