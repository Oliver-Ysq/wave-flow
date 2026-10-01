# Wave Flow

Wave Flow 是一个面向本机单用户的动态工作流产品：用户将以 TypeScript 编排任务，每个 Agent 节点最终会托管一个真实、长期存活、可交互的 Codex 或 Claude Code CLI 会话。本地 CLI 与 Web 控制台会共同管理 daemon；完整目标与安全边界见 [设计规格](./docs/wave-flow-design.md)。

## 当前状态

项目已完成旧一次性 `codex exec` Runtime 的移除，并按职责建立源码边界。当前**没有可供用户执行 Workflow 的 `run`、`resume`、`inspect` 或 Adapter 命令**；也尚未实现 tmux / PTY、正常交互式 CLI、Local Web、HITL、Journal 或 Replay。

这意味着历史的 `ctx.agent()`、Fake Adapter、`codex exec --json`、旧示例和旧 Journaled Replay 都不再可用，也不代表本项目的当前能力。

## 开发与验证

项目使用 [Bun](https://bun.sh/) 与 TypeScript：

```bash
bun run check
bun test
git diff --check
```

后续能力会按 [研发路线](./docs/wave-flow-chapter.md) 逐章实现。README 只会在功能实际可用后补充安装与命令说明。
