#!/usr/bin/env bun
import { DaemonClient, UnsupportedDaemonCloseEndpointError } from "./daemon-client";
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
    : command.kind === "inspect" || command.kind === "answer" || command.kind === "close"
      ? await discoverDaemon()
      : await ensureGlobalDaemon(10_000, command.kind === "web" ? write : undefined);
  const testServer = testDaemon?.start();
  try {
    const baseUrl = daemon?.baseUrl ?? testServer?.baseUrl;
    if (command.kind === "start") {
      if (!baseUrl) throw new Error("无法连接 Wave Flow daemon。");
      write(`Wave Flow daemon 已就绪：${baseUrl}`);
      return;
    }
    if (command.kind === "web") {
      if (!baseUrl) throw new Error("无法连接 Wave Flow daemon。 ");
      write("已确认 daemon 只监听 loopback，同源 Local Web 静态资源可用。");
      write(`Wave Flow Local Web：${baseUrl}/`);
      return;
    }
    if (command.kind === "close") {
      if (!daemon) throw new Error("没有可验证的 Wave Flow daemon 可关闭。 ");
      try {
        await new DaemonClient(daemon.baseUrl).closeDaemon();
        write("Wave Flow daemon 已接受关闭请求。");
      } catch (error) {
        if (!(error instanceof UnsupportedDaemonCloseEndpointError)) throw error;
        await terminateVerifiedLegacyDaemon(daemon);
        write("旧版 Wave Flow daemon 已安全终止。");
      }
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
    if (command.kind === "pause") { const response = await client.pause(command.runId); write(formatSnapshot(response.snapshot)); return; }
    if (command.kind === "recover") { const response = await client.recover(command.runId); write(formatSnapshot(response.snapshot)); return; }
    if (command.kind === "stop") { const response = await client.stop(command.runId); write(formatSnapshot(response.snapshot)); return; }
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

/**
 * 旧 daemon 没有 `/daemon/close` 时的唯一兼容出口。
 * 再次发现并逐字段比对，避免 descriptor 在 HTTP 请求与信号之间被新 daemon 替换。
 */
export async function terminateVerifiedLegacyDaemon(daemon: NonNullable<Awaited<ReturnType<typeof discoverDaemon>>>): Promise<void> {
  const current = await discoverDaemon();
  if (!current
    || current.baseUrl !== daemon.baseUrl
    || current.descriptor.pid !== daemon.descriptor.pid
    || current.descriptor.bootInstanceId !== daemon.descriptor.bootInstanceId
    || current.descriptor.processStartIdentity !== daemon.descriptor.processStartIdentity
    || current.descriptor.userIdentity !== daemon.descriptor.userIdentity) {
    throw new Error("旧 daemon 的身份在关闭前发生变化，拒绝终止。请重新执行 wave-flow close。");
  }
  try { process.kill(current.descriptor.pid, "SIGTERM"); } catch (error) {
    throw new Error(`无法终止已验证的旧 daemon：${error instanceof Error ? error.message : String(error)}`);
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
