# Local Web 交付层

`web/` 目录是 React + Vite 源码：它实现 Run 总览、Phase → Agent 执行轨迹、结果、HITL 答复和运行控制。

```bash
bun run web:dev    # 仅前端开发预览；代理 daemon API
bun run web:build  # 生成同源生产静态资源
```

`src/web/dist/` 是受版本控制的 Vite 构建产物。`LocalDaemon` 只监听 loopback，并同源提供该产物；React 页面只调用 daemon API / SSE，不能读取 Journal、控制 tmux 或直接连接 App Server。
