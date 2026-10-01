# Session Backends

tmux / PTY 后端及其三态存活探测在这里实现。后端必须管理资源和身份记录，不得创建 Workflow 节点或从终端文本推断完成状态。
