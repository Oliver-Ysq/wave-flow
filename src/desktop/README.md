# Desktop 目录

- `desktop-execution-engine.ts`：Desktop Execution Engine，Run 生命周期、Journal、
  Control capability、Harness、项目与 CLI Registry 的唯一状态权威。不监听端口、不发布
  descriptor/PID/heartbeat；Tauri 仅经私有进程管道调用业务方法。
- `engine-main.ts`：Engine 私有入口（stdin/stdout JSONL），同时承载打包后的
  `__codex-acp`、`__worker-mcp`、`__harness-mcp`、`__mcp-probe` 子命令；只由 Tauri
  启动。父进程看门狗与 stdin EOF 都显式退出，不留下无人认领的 Engine。
- `engine-dispatch.ts`：并发派发 JSONL 请求，按 `requestId` 关联响应并在 shutdown 时
  排空在途请求；慢 action 落盘诊断，不阻塞后续请求。
- `execution-assignment.ts`：把已枚举 Worker、已验证 CLI 与用户选择组装成可冻结的
  Execution 配置快照，只做纯校验，不触碰磁盘或会话。
- `project-context.ts`：主页只读 Git 分支上下文，不作为执行授权或冻结基准。
- `types.ts`：Desktop action 的请求/响应类型；字段级注释描述含义、默认值与运行时影响。
