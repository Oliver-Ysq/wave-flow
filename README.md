# Wave Flow

面向本机单用户的 AI Coding Agent 工作流桌面应用。

中文 | [English](./README.en.md)

## 当前可用能力

- 以项目组织持续任务，主控通过普通对话理解目标、提出工作流方案。
- 支持自动编排，以及内置的只读代码审查与独立复核预置工作流。
- 主控辅助补齐缺失参数；用户也可直接修改紧凑参数区，可选项折叠。
- 方案以 Phase → Worker 展示，Worker 行内选择已验证的 Codex 或 Kimi CLI，使用 CLI 自身默认模型。
- 一次“确认并运行”采用当前参数草稿；“保存待运行”只保存未批准方案，不启动 Worker。
- 修改保留不可变版本；旧版本、旧回合和迟到请求不能覆盖当前方案。同一确认请求重试不会重复创建执行。
- 查看执行进度、结构化结果与历史尝试；支持人工协助、暂停、恢复、停止及中断后的显式恢复。
- 每个 Worker 绑定独立真实 ACP 会话；只有私有控制 MCP 经 Schema 校验与 Journal 耐久记录后，才能改变业务状态。

## 快速开始

开发环境需要 [Bun](https://bun.sh/)、Rust/Tauri 构建工具，以及 Codex CLI 或 Kimi CLI（至少其一）。

```bash
bun install
bun run desktop:build
# 打开 src-tauri/target/release/bundle/macos/Wave Flow.app
```

在应用中添加本地项目，进入“主控与执行底座设置”验证 CLI 并选择主控，然后新建任务。预置来源可选择让主控准备参数，或直接填写并保存；在 Workflow 设计中确认参数与 CLI 后运行。

Desktop 启动本次应用专属的 Execution Engine，通过私有 IPC 通信，不启动全局 daemon、不开放 HTTP 端口。关闭窗口只隐藏工作台，任务继续；从应用菜单明确退出会耐久取消活动执行并回收会话。重开不会自动重跑，恢复必须由用户明确发起。

## 运行语义与限制

- 当前提供 macOS Apple Silicon 开发构建。本地工作流文件的任务关联入口尚未开放；没有独立控制 CLI 或浏览器 HTTP 工作台。
- 预置目录当前只有只读审查模板；不能下载 URL 工作流。复杂对象参数保留原值，通过主控对话调整。
- Workflow 设计是源码声明示意，不是可视化编辑器，也不承诺动态调用次数。真实阶段访问和结果以执行记录为准。
- 主控不能批准、执行工作流或直接控制 Worker；用户确认才授权运行。普通参数通过对话收集，业务型人工决策仍使用显式等待与答案表单。
- 人类答复只交付信息，原 Worker 确认继续后才恢复运行；ACP 回合结束、自然语言“完成”和进程退出都不是完成证据。
- Engine 重启不认领旧 ACP 会话，不自动重发任务；恢复仅复用同一执行中严格匹配的 completed 前缀。Journal 不回滚业务文件或外部副作用。
- 默认共享项目目录；并行写入需要证明路径不重叠，冲突任务必须顺序执行。支持 read-only / workspace-write，不提供全权限模式。
- 前次执行终态、主控空闲后，可显式准备下一份工作流；不自动注入旧结果。自动汇总、TraeX、Retry 与 worktree 隔离尚未实现。
- 模型提问质量不保证确定性；无已验证 CLI 或身份漂移时拒绝启动。真实中文输入法候选提交与完整App启动/输入延迟仍需专项验证。正文格式按需加载，等待或失败保留可读原文并提供重试。

## 开发与验证

```bash
bun run check
bun test --timeout 30000
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

前端开发可运行 `bun run desktop:dev`。Vite 仅用于开发；发布应用使用内置页面与私有 Engine，不提供浏览器 fallback。
