import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";

/**
 * Worker supervisor 的耐久启动报告。
 *
 * 写者证据落盘前存在一个“provider 可能已创建、但 Journal 还没有进程身份”的窗口。
 * supervisor 在 spawn provider 之前先写启动标记，spawn 后写 provider 报告；恢复端
 * 据此区分“从未启动”“启动中”与“provider 已存在”，不再把无法核验的意图永久
 * 变成无法恢复。
 */

/** supervisor 报告目录；测试与隔离运行可注入 `WF_SUPERVISOR_REPORT_DIR`。 */
export function supervisorReportDir(): string {
  return process.env.WF_SUPERVISOR_REPORT_DIR?.trim() || join(waveFlowHome(), "runtime");
}

/** 由 Run/节点/会话身份派生稳定 launch key；同一 attempt 原地续用共用同一 key。 */
export function writerLaunchKey(runId: string, nodeId: string, agentSessionId: string): string {
  return createHash("sha256").update(`${runId}\0${nodeId}\0${agentSessionId}`).digest("hex").slice(0, 32);
}

/** provider 报告文件；绝对路径。 */
export function reportPathFor(key: string, directory = supervisorReportDir()): string {
  return join(directory, `launch-${key}.pid`);
}

/** supervisor 启动标记；在 spawn provider 之前原子写入。 */
export function launchMarkerPath(reportPath: string): string {
  return `${reportPath}.launch`;
}

/** 恢复端看到的启动状态。 */
export type SupervisorLaunchState =
  /** 没有 supervisor 启动记录：可以证明 provider 从未创建。 */
  | { readonly kind: "missing" }
  /** supervisor 已启动但 provider 报告尚未落盘；不代表 provider 一定存在。 */
  | { readonly kind: "launching"; readonly supervisorPid: number }
  /** provider 已创建；pgid 与启动指纹来自 supervisor 同源采集。 */
  | { readonly kind: "provider"; readonly pgid: number; readonly startedAt: string };

/** 读取启动状态；pid 报告优先于启动标记，两者都不存在才是 missing。 */
export async function readLaunchState(reportPath: string): Promise<SupervisorLaunchState> {
  const provider = await readProviderReport(reportPath);
  if (provider) return provider;
  const raw = await Bun.file(launchMarkerPath(reportPath)).text().catch(() => null);
  const pid = raw === null ? NaN : Number(raw.trim());
  if (Number.isSafeInteger(pid) && pid > 1) return { kind: "launching", supervisorPid: pid };
  return { kind: "missing" };
}

/** 读取 provider 报告；文件未写出或内容不完整时返回 null。 */
export async function readProviderReport(reportPath: string): Promise<Extract<SupervisorLaunchState, { kind: "provider" }> | null> {
  const text = await Bun.file(reportPath).text().catch(() => null);
  if (text === null) return null;
  const lines = text.trim().split("\n");
  const pgid = Number(lines[0]?.trim());
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return null;
  return { kind: "provider", pgid, startedAt: lines[1]?.trim() ?? "" };
}

/** 删除启动标记与 provider 报告；只在状态已确定或 supervisor 正常收尾后调用。 */
export async function removeLaunchFiles(reportPath: string): Promise<void> {
  await Promise.all([
    rm(reportPath, { force: true }).catch(() => {}),
    rm(launchMarkerPath(reportPath), { force: true }).catch(() => {}),
  ]);
}
