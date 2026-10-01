# Session Host

此目录在第 5 章实现每个 Agent 节点的会话身份、attach、detach、destroy 与 liveness 语义。生产默认是 tmux，PTY 仅用于开发或故障降级。

`backends/` 管理 tmux / PTY 资源；`bootstrap/` 协调 Adapter 的 Ready/Input Gate。它们不解释 Workflow，也不直接改变节点业务状态。
