# Session Host

此目录将定义每个 Agent 节点的 `SessionBackend` 会话身份、attach、detach、destroy 与 liveness 语义。P0 默认且唯一生产实现是 tmux；Herdr 与 PTY 是未来 P2 可选后端。PTY 不承诺 daemon 重启后存活；Herdr 只能在其 server 与原 pane 均验证存活时重新绑定，不能替代 Wave Flow 的显式恢复。

`backends/` 管理具体会话资源；`bootstrap/` 协调 Adapter 的 Ready/Input Gate。后端观察到的终端文本或 Agent 状态只作诊断，不能直接改变节点业务状态。
