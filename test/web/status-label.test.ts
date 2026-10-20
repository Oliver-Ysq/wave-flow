import { expect, test } from "bun:test";
import { statusLabel } from "../../src-tauri/web/src/execution/status-label";

test("工作台与团队面板共用原状态词表，不混入工具或进度卡语义", () => {
  const labels = { queued: "排队中", running: "工作中", blocked: "需要协助", pausing: "暂停中", paused: "已暂停", recovering: "恢复中", completed: "已完成", cancelled: "已停止", interrupted: "已中断" };
  for (const [status, label] of Object.entries(labels)) expect(statusLabel(status)).toBe(label);
  for (const status of ["failed", "unknown", ""]) expect(statusLabel(status)).toBe(status);
});
