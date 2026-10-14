# Desktop 目录

- `desktop-execution-engine.ts`：Desktop Execution Engine，Run 生命周期、Journal、Control capability、Harness 与 Worker 名额的唯一状态权威。不监听端口、不发布 descriptor/PID/heartbeat；Tauri 仅经私有进程管道调用业务方法。
- `engine-main.ts`：Engine 私有入口（stdin/stdout JSONL），同时承载打包后的 `__codex-acp`、`__worker-mcp`、`__harness-mcp` 子命令；只由 Tauri 启动。
- `types.ts`：Desktop action 的请求/响应类型；字段级注释描述含义、默认值与运行时影响。
