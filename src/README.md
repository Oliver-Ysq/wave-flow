# Wave Flow 源码边界

本目录按新架构职责分层。Workflow 层现已提供受信任本地 `.ts` 模块加载、纯字面量 `meta` 校验，以及以 AsyncLocalStorage 隔离的 `agent()`、`phase()`、`parallel()`、`pipeline()` 和 `log()` 作者 API；CLI 默认使用真实 Codex App Server 的 `turn/start` ACK 投递首条任务，并保留 tmux remote viewer。普通 tmux paste/history 是显式兼容路径；两者都不提供旧一次性 `codex exec` Runtime。

| 目录 | 负责 | 不负责 |
| --- | --- | --- |
| `workflow/` | Workflow 加载、静态 `meta` 与作者 API | 启动具体 CLI |
| `runtime/` | Run、Phase、Agent 状态与调度 | 解析 CLI 终端文本 |
| `sessions/` | AgentSession 与 tmux / PTY 生命周期 | 决定 Workflow 拓扑 |
| `adapters/` | Codex 及后续 TraeX 正常 CLI 与能力声明 | 持久化 Run 状态 |
| `control/` | `complete` / `block` / `fail` 与 capability | 解释自然语言终端输出 |
| `journal/` | Manifest、事件、结果与 Replay 证据 | 回滚外部副作用 |
| `daemon/` | 仅限 localhost 的 API 与服务生命周期 | 复制 Workflow 规则 |
| `cli/` | 用户命令及受管 Agent 子命令 | 绕过 daemon 修改状态 |
| `web/` | Phase → Agent 的本地展示与控制 | 编辑 Workflow 源码 |
| `shared/` | 无业务副作用的类型、ID、哈希、路径与 JSON 工具 | 依赖任一运行层 |

`sessions/backends/` 只放 tmux / PTY 后端；`sessions/bootstrap/` 只放首条 Prompt 的 Ready/Input Gate 编排。后续章节必须在对应目录实现，不能重新建立跨层的平铺模块。
