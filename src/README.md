# `src/` 模块边界

`workflow/` 提供受信任本地 TypeScript Workflow 的加载、纯字面量 `meta` 校验，以及以 AsyncLocalStorage 隔离的 `agent()`、`phase()`、`parallel()`、`pipeline()` 和 `log()` 作者 API。

真实 Worker 路径固定为：

```text
Runtime → RuntimeAcpWorkerExecutor → Codex ACP → Control → Journal
```

`runtime/` 负责调度、暂停、同 daemon recover 与显式 resume；`adapters/acp-session.ts` 只负责 ACP 协议；`control/` 是唯一的 `complete / block / continue` 状态入口；`daemon/` 只提供 loopback API、资源护栏与耐久 Run 生命周期。浏览器和桌面端不直接连接 Worker，也不承载终端或会话认领逻辑。
