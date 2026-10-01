# Session Bootstrap

这里协调已创建会话和 Adapter 专属的 Ready/Input Gate，确认首条 Prompt 已真正提交到正常交互式 CLI。Runtime 不在此处解析 ANSI 或猜测 Composer 状态。
