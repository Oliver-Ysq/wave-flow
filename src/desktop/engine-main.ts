#!/usr/bin/env bun
import { DesktopExecutionEngine } from "./desktop-execution-engine";
import { serveEngineRequests } from "./engine-dispatch";

/**
 * 仅由 Tauri 启动的 Desktop Execution Engine 入口。
 *
 * 不监听网络端口，不发布任何发现信息；stdin EOF 表示 Tauri 已失去
 * 该私有通道，Engine 释放会话后退出。正常桌面退出使用 engine.shutdown：先
 * durable-first 写入 cancelled 再尽力终止 Worker 进程组。
 */
async function main(): Promise<void> {
  // 子进程（ACP adapter 与两类 MCP）必须知道自己属于打包 Desktop Engine，不能
  // 解析或启动历史控制面入口。
  process.env.WF_DESKTOP_ENGINE = "1";
  const deterministicForTest = process.env.WF_ENGINE_DETERMINISTIC === "1";
  const engine = new DesktopExecutionEngine({ deterministicForTest });
  // 父进程存活看门狗。控制流逐行移植自 Orca `installDevParentWatchdog`
  // （src/main/startup/configure-process.ts）；生产适用性对应
  // provider-process-supervisor.ts 的 ownerGone 检查（reparent 可能落在
  // PID 1 或 subreaper，任何其他父进程都表示 owner 已消失）。
  const stopParentWatchdog = installParentWatchdog(() => {
    engine.shutdown();
    process.exit(0);
  });
  // Engine 进程重启时绝不认领旧 ACP session。必须在接受任何新 action 前将
  // 上一个进程遗留的活跃事实收敛，避免 UI 短暂展示一个实际上无人持有的 Worker。
  await engine.convergeStaleAcpWorkers();
  // 事件帧与请求响应共用同一 stdout JSONL 通道：响应带 requestId，事件帧不带；
  // Tauri 按帧形状分流，迟到旧进程帧由 generation 校验丢弃。
  engine.subscribeEvents((frame) => write(frame));
  write({ type: "ready", protocolVersion: 1 });
  engine.refreshSelectedHarness();
  const reader = new TextDecoder();
  let buffered = "";
  const lines = async function* (): AsyncGenerator<string> {
    for await (const chunk of Bun.stdin.stream()) {
      buffered += reader.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (line.trim()) yield line;
      }
    }
    if (buffered.trim()) yield buffered;
  };
  try {
    // 并发派发在 engine-dispatch 中实现并可独立测试；单个慢/挂死 action
    // 不再阻塞后续请求，shutdown 时排空在途请求后退出。
    await serveEngineRequests(engine, lines(), write);
  } finally {
    stopParentWatchdog();
    engine.shutdown();
  }
}

function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

/**
 * 父进程存活看门狗：逐行移植 Orca `installDevParentWatchdog`
 * （src/main/startup/configure-process.ts）。每秒检查 ppid 是否变化，并用
 * `kill(pid, 0)` 的 ESRCH 判断父进程是否消失；未知错误按 Orca 的做法重新抛出。
 * 返回清理函数，正常退出时移除定时器。
 */
function installParentWatchdog(onParentGone: () => void): () => void {
  const initialParentPid = process.ppid;
  if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) return () => {};
  const timer = setInterval(() => {
    const parentPidChanged = process.ppid !== initialParentPid;
    let parentMissing = false;
    try {
      process.kill(initialParentPid, 0);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
        parentMissing = true;
      } else {
        throw error;
      }
    }
    if (parentPidChanged || parentMissing) {
      clearInterval(timer);
      onParentGone();
    }
  }, 1_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** 打包后的 Worker MCP 也必须由 Engine binary 启动，不能回退到任何旧控制面入口。 */
process.env.WF_DESKTOP_ENGINE = "1";
if (process.argv[2] === "__codex-acp") {
  await import("@agentclientprotocol/codex-acp");
} else if (process.argv[2] === "__worker-mcp") {
  const { runWorkerMcpServer } = await import("../runtime/worker-mcp-server");
  // 测试注入的小预算走显式参数；生产路径永远使用默认 25s，不读取任何用户配置。
  const budgetOverride = Number(process.env.WF_WORKER_BLOCK_WAIT_BUDGET_MS);
  await runWorkerMcpServer(Number.isFinite(budgetOverride) && budgetOverride > 0 ? budgetOverride : undefined);
} else if (process.argv[2] === "__harness-mcp") {
  const { runHarnessMcpServer } = await import("../harness/mcp-server");
  await runHarnessMcpServer();
} else if (process.argv[2] === "__mcp-probe") {
  const { runMcpProbeServer } = await import("../runtimes/mcp-probe");
  await runMcpProbeServer();
} else {
  main().catch((error) => { process.stderr.write(`Wave Flow Desktop Engine: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
