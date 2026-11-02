import type { AgentNodeSnapshot } from "./run-types";
import { fenceAcpWriter } from "../workspace/writer-process-control";
import {
  readLaunchState,
  removeLaunchFiles,
  reportPathFor,
  supervisorReportDir,
  writerLaunchKey,
} from "../runtimes/supervisor-report";

/** 一个无法核验旧 provider 的节点；调用方必须拒绝恢复。 */
export type AcpFenceFailure = {
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 不可核验的原因，直接进入拒绝诊断。 */
  readonly reason: string;
};

/**
 * 恢复前核验所有带写者证据且未 completed 的 ACP 节点。
 *
 * 有进程证据时直接围栏该进程组。只有启动意图时，用 supervisor 的耐久启动报告判定：
 * 没有启动记录 = provider 从未创建；有 provider 报告 = 按报告围栏；只有启动标记 =
 * 等待 supervisor 完成或退出后再判定。无法判定才 fail closed。
 */
export async function fenceAcpNodeWriters(
  runId: string,
  nodes: readonly AgentNodeSnapshot[],
  options?: { /** supervisor 报告目录；测试可注入，缺省用 Engine 运行时目录。 */ readonly reportDir?: string },
): Promise<{ readonly failures: readonly AcpFenceFailure[]; readonly checked: number }> {
  const failures: AcpFenceFailure[] = [];
  let checked = 0;
  for (const node of nodes) {
    if (node.status === "completed") continue;
    if (node.writerIntentAt) {
      // 启动意图优先于旧进程证据：原地续用可能已经围栏旧 writer，但新 provider 尚未落证据。
      const result = await fenceLaunchWindow(runId, node, options?.reportDir ?? supervisorReportDir());
      if (result.checked) checked += 1;
      if (result.reason) failures.push({ nodeId: node.id, reason: result.reason });
      continue;
    }
    if (!node.writer) continue;
    checked += 1;
    const result = await fenceAcpWriter(node.writer);
    if (result.outcome === "unknown") failures.push({ nodeId: node.id, reason: result.reason });
    else if (node.agentSessionId) await removeLaunchFiles(reportPathFor(writerLaunchKey(runId, node.id, node.agentSessionId), options?.reportDir ?? supervisorReportDir()));
  }
  return { failures, checked };
}

/**
 * 只凭启动意图恢复：读取 supervisor 报告，必要时等待“启动中 → provider 报告/退出”。
 *
 * 返回 reason 表示无法核验；返回空 reason 表示已证明安全（provider 不存在或已围栏）。
 */
async function fenceLaunchWindow(
  runId: string,
  node: AgentNodeSnapshot,
  reportDir: string,
): Promise<{ readonly checked: boolean; readonly reason: string }> {
  if (!node.agentSessionId) return { checked: false, reason: "存在 provider 启动意图但没有会话身份，无法核验。" };
  const reportPath = reportPathFor(writerLaunchKey(runId, node.id, node.agentSessionId), reportDir);
  const deadline = Date.now() + 2_000;
  for (;;) {
    const state = await readLaunchState(reportPath);
    if (state.kind === "provider") return fenceReportedProvider(reportPath, state);
    if (state.kind === "missing") return { checked: false, reason: "" };
    if (!supervisorAlive(state.supervisorPid)) {
      // supervisor 已退出：再读一次，避免报告落盘与退出之间的竞态。
      const settled = await readLaunchState(reportPath);
      if (settled.kind === "provider") return fenceReportedProvider(reportPath, settled);
      // 已退出且没有 provider 报告：provider 未被创建（报告失败时 supervisor 会先杀 provider）。
      await removeLaunchFiles(reportPath);
      return { checked: false, reason: "" };
    }
    if (Date.now() >= deadline) {
      // supervisor 启动后长时间没有 provider 报告：请求它收尾，避免把无法核验的状态留给下一次恢复。
      try { process.kill(state.supervisorPid, "SIGTERM"); } catch { /* 已退出 */ }
      const stopped = await waitSupervisorExit(state.supervisorPid, 1_000);
      const settled = await readLaunchState(reportPath);
      if (settled.kind === "provider") return fenceReportedProvider(reportPath, settled);
      // supervisor 已停止且始终没有 provider 报告：provider 未被创建（或报告失败时 supervisor
      // 已自行杀掉 provider）。只有 supervisor 仍无法确认退出才 fail closed。
      if (!stopped) return { checked: false, reason: `supervisor 启动后未报告 provider，且未能在预算内确认其退出（pid=${state.supervisorPid}）。` };
      await removeLaunchFiles(reportPath);
      return { checked: false, reason: "" };
    }
    await Bun.sleep(25);
  }
}

/** 按 supervisor 报告围栏 provider；成功证明后删除报告，避免重复判定。 */
async function fenceReportedProvider(
  reportPath: string,
  report: { readonly pgid: number; readonly startedAt: string },
): Promise<{ readonly checked: boolean; readonly reason: string }> {
  const result = await fenceAcpWriter({ pgid: report.pgid, startedAt: report.startedAt });
  if (result.outcome === "unknown") return { checked: true, reason: `启动意图对应的 provider 无法核验：${result.reason}` };
  await removeLaunchFiles(reportPath);
  return { checked: true, reason: "" };
}

/** supervisor 进程是否仍存在；EPERM 说明存在但不可信号，僵尸进程视为已退出。 */
function supervisorAlive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  // 已退出但尚未被父进程回收的僵尸仍能通过 kill(pid,0)；它不可能再 spawn provider。
  const result = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe", timeout: 1_000 });
  if (result.exitCode !== 0) return false;
  const state = new TextDecoder().decode(result.stdout).trim();
  return state.length > 0 && !state.startsWith("Z");
}

/** 有界等待 supervisor 退出。 */
async function waitSupervisorExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (supervisorAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}
