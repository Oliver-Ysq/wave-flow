#!/usr/bin/env bun
import { DaemonClient } from "./daemon-client";
import { formatCapabilities, formatSnapshot, helpText } from "./output";
import { parseCommand } from "./parse-command";
import { discoverDaemon, ensureGlobalDaemon } from "../daemon/daemon-lifecycle";
import { inspectStoredRun, LocalDaemon } from "../daemon/local-daemon";
import { runsRoot } from "../journal/paths";
import { executeComplete, parseCompleteCommand } from "./complete-command";
import { executeBlock, parseBlockCommand } from "./block-command";
import { executeAnswer, executeContinue, parseAnswerCommand, parseContinueCommand } from "./hitl-command";

/** CLI 主入口；run 通过 daemon 创建，inspect 读取同一 daemon 的权威状态。 */
export async function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd(), write: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); }, deterministicForTest = false): Promise<void> {
  const command = parseCommand(argv, cwd);
  if (command.kind === "help") { write(helpText); return; }
  if (command.kind === "complete") { await executeComplete(parseCompleteCommand(command.argv)); write("节点已完成上报。"); return; }
  if (command.kind === "block") {
    const resolution = await executeBlock(parseBlockCommand(command.argv));
    write(JSON.stringify(resolution));
    return;
  }
  if (command.kind === "continue") { await executeContinue(parseContinueCommand(command.argv)); write("节点已恢复运行。"); return; }
  const testDaemon = deterministicForTest ? new LocalDaemon({ deterministicForTest: true, storeRoot: runsRoot(`${cwd}/.test-wave-flow`) }) : null;
  // inspect 与 answer 都不能为了查询历史状态或交付 pending block 悄悄启动新 daemon。
  // 前者只允许读取已终结 Run 的耐久证据；后者必须交给仍持有原等待者的 daemon。
  const daemon = deterministicForTest
    ? null
    : command.kind === "inspect" || command.kind === "answer"
      ? await discoverDaemon()
      : await ensureGlobalDaemon();
  const testServer = testDaemon?.start();
  try {
    const baseUrl = daemon?.baseUrl ?? testServer?.baseUrl;
    if (command.kind === "start") {
      if (!baseUrl) throw new Error("无法连接 Wave Flow daemon。");
      write(`Wave Flow daemon 已就绪：${baseUrl}`);
      return;
    }
    if (command.kind === "serve") {
      if (!baseUrl) throw new Error("无法连接 Wave Flow daemon。");
      write(`Wave Flow daemon: ${baseUrl}`);
      if (!deterministicForTest) await waitForInterrupt();
      return;
    }
    if (command.kind === "inspect" && !baseUrl) {
      const response = await inspectStoredRun(command.runId);
      write(formatSnapshot(response.snapshot));
      return;
    }
    if (!baseUrl) {
      if (command.kind === "answer") throw new Error("没有可验证的 Wave Flow daemon；当前版本不能在 daemon 重启后交付 pending block 答案。");
      throw new Error("无法连接 Wave Flow daemon。");
    }
    const client = new DaemonClient(baseUrl);
    if (command.kind === "answer") { await executeAnswer(parseAnswerCommand(command.argv), baseUrl); write("答案已交付给等待中的 Agent。"); return; }
    if (command.kind === "resume") { const response = await client.resume(command.runId); write(formatSnapshot(response.snapshot)); return; }
    if (command.kind === "capabilities") {
      const snapshot = await client.capabilities();
      write(command.json ? JSON.stringify(snapshot, null, 2) : formatCapabilities(snapshot));
      return;
    }
    const response = command.kind === "run"
      ? await client.createRun({ clientRequestId: crypto.randomUUID(), workflowPath: command.workflowPath, cwd: command.cwd, input: command.input, codexRpcInput: command.codexRpcInput })
      : await client.inspect(command.runId);
    write(formatSnapshot(response.snapshot));
    if (command.kind === "run" && response.snapshot.status === "running" && !deterministicForTest) {
      write("正在实时显示本次 Run 的进展；按 Ctrl-C 仅退出观看，后台任务会继续运行。");
      await followRun(client, response.runId, write);
    }
  } finally {
    // 生产 daemon 属于用户级后台服务，CLI 绝不停止它。测试 daemon 是本调用私有的。
    testServer?.stop();
  }
}

/** run 默认实时跟随本次 Run；Ctrl-C 只退出观看器，后台 daemon 与 Agent 继续。 */
async function followRun(client: DaemonClient, runId: string, write: (line: string) => void): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  let previous = "";
  try {
    await client.followRun(runId, (response) => {
      const rendered = formatSnapshot(response.snapshot);
      if (rendered === previous) return;
      previous = rendered;
      write(`\n${rendered}`);
    }, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    write(`已停止观看 Run ${runId}；后台任务仍在继续。`);
  } finally { process.removeListener("SIGINT", stop); }
}

/** serve 只是前台观察客户端；收到中断后退出，不停止全局 daemon。 */
function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    process.once("SIGINT", () => { clearInterval(keepAlive); resolve(); });
  });
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`wave-flow: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
