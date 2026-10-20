# `src/` 模块边界

`workflow/` 提供受信任本地 TypeScript Workflow 的加载、纯字面量 `meta` 校验，以及以
AsyncLocalStorage 隔离的 `agent()`、`phase()`、`parallel()`、`pipeline()` 和 `log()`
作者 API。`index.ts` 是作者与 Runtime 共用的公开导出面。

真实 Worker 路径固定为：

```text
Runtime → RuntimeAcpWorkerExecutor → 本机 CLI ACP（Codex / Kimi） → Control → Journal
```

- `runtime/`：Run 调度、暂停与显式 resume、停滞检测、Replay 与 Worker 进程控制。
- `runtimes/`：CLI Registry、PATH 与安装目录发现、版本探测、ACP 验证与会话隔离。
- `adapters/`：ACP 协议与本地 stdio 进程组，不持有业务状态。
- `control/`：唯一的 `complete / block / continue` 状态入口与 capability 校验。
- `journal/`：Run 耐久事件、重放与路径。
- `harness/`：主控对话、Task 生命周期、Execution 冻结/恢复与私有 MCP 窄工具。
- `workspace/`：Git worktree、成果保存、显式集成与 squash 合入。
- `desktop/`：Desktop Engine（本次应用的唯一状态权威）与 Tauri 私有 action 派发。
- `shared/`：无业务副作用的类型、ID、哈希、路径与 JSON 工具。

桌面端没有 daemon、loopback API 或终端解析：Tauri 通过私有 stdin/stdout JSONL 调用
Engine，浏览器与 Web 工作台不直接连接 Worker，也不承载会话认领逻辑。
