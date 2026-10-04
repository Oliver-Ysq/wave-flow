# Session Bootstrap

这里的 `InteractiveCliBootstrap` 协调已创建会话和 Adapter 专属的 `launch → ready → submit → confirm` Gate。它只处理会话身份、调用顺序与 fail-closed 清理；Runtime、SessionBackend 和 Bootstrap 都不解析 ANSI、终端文本或任何 CLI 的历史文件。当前仅 Codex 有实现；TraeX 必须在其 Adapter 中实现独立的可验证确认策略后才能注册。
