# Tauri Desktop

此目录保存 Wave Flow 的 Tauri 壳、随包 Desktop Engine 声明和 macOS 打包配置。

`bun run desktop:build` 在 Tauri 构建后统一签名内嵌 Engine 与外层 App，并执行严格
签名校验。开发机没有证书时使用 ad-hoc 身份；这修复包身份分裂，不承诺首次弹窗数量或
跨版本授权稳定。正式分发必须使用 Developer ID Application，并单独验证 hardened
runtime、Bun JIT entitlement 和公证；设置 `APPLE_SIGNING_IDENTITY` 本身不代表公证完成。

桌面端启动本次应用专属Engine并经私有进程管道转发React工作台请求；不监听或连接
loopback daemon。Runtime、Journal、Control与Agent会话均由Engine持有，Tauri不成为
第二套业务状态权威。
