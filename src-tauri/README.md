# Tauri Desktop

此目录保存 Wave Flow Desktop 的 Tauri 壳、随包 Bun sidecar 声明和 macOS 打包配置。

桌面端仅通过 bridge 发现或启动已验证的 loopback daemon，并导航到 daemon 同源 UI；它不读取 Journal、不管理 Run，也不持有 Control 或 Agent 会话状态。
