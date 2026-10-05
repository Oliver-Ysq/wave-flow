# Wave Flow

Wave Flow 是一个面向本机单用户的动态工作流产品：用户将以 TypeScript 编排任务，每个 Agent 节点最终会托管一个真实、长期存活、可交互的 Codex CLI 会话。本地 CLI 与 Web 控制台会共同管理 daemon。TraeX 是短期后续接入目标，当前尚不可用。

## 当前状态

项目已完成旧一次性 `codex exec` Runtime 的移除，并按职责建立源码边界。`run` 默认会在私有 tmux 会话中启动正常交互式 Codex，确认首条任务进入会话后立刻返回 RunId，并在当前终端持续显示状态变化，直到 Agent 调用 `wave-flow complete` 上报结构化结果。`inspect` 用于再次读取 Run 状态。Local Web、HITL、Replay、跨 daemon 恢复与 TraeX 尚未实现。

这意味着历史的 `ctx.agent()`、`codex exec --json`、旧示例和旧 Journaled Replay 都不再可用，也不代表本项目的当前能力。

## 本地开发验证

先将当前包注册到本机：

```bash
bun link
```

Workflow 使用 `agent()`、`phase()` 等作者 API，必须先选择 `meta.phases` 中声明的阶段：

```ts
import { agent, phase } from "wave-flow";

export const meta = {
  name: "local-check",
  description: "验证本地 CLI 路径。",
  phases: [{ title: "检查" }],
};

export default async function run(args: { target: string }) {
  phase("检查");
  return agent("检查目标。", {
    id: "check-target",
    cli: "codex",
    input: { target: args.target },
  });
}
```

运行后会自动显示进展：

```bash
# 可选：先显式启动后台 daemon；只启动，不创建任务
wave-flow start
wave-flow run ./.wave-flow/workflows/local-check.ts --input '{"target":"src"}'
# 如果之后想重新查看，使用上一步输出的 RunId：
wave-flow inspect <run-id>
wave-flow capabilities --json
```

`run` 会输出唯一的 RunId，并把 Run、事件、会话坐标与结果写入 `~/.wave-flow/runs/<run-id>/`。创建 Run 和首条任务安全投递完成后，命令不会等待 Agent 完成，而是自动订阅 daemon 的状态流：节点开始、阻塞、完成或 Run 被中断都会显示在同一个终端。按 `Ctrl-C` 只停止观看，不停止后台 daemon 或 Agent；之后可用 `inspect` 再次查看。默认经本机 App Server 的 `turn/start` ACK 投递首条任务，同时保留 tmux 中的 Codex viewer；传入 `--tmux-tui-input` 可显式改用普通 tmux TUI 的 paste/history 兼容路径。两种模式都由 Agent 的 `wave-flow complete` 作为唯一完成依据。

`wave-flow start` 只确保当前用户的全局 daemon 已启动、健康并输出地址，然后立刻退出；它不会创建 Run。`run` 和 `serve` 仍会在 daemon 未启动时自动启动它，所以 `start` 是可选的显式操作入口。

`capabilities --json` 输出当前机器的三态能力快照。命令存在只代表二进制可被探测；`unknown` 表示尚未形成环境结论，`unavailable` 表示已确认不能使用。真实 Runtime 会在启动前检查 tmux 与 Codex 二进制，并在会话启动、首条任务确认时继续 fail closed；不会把终端文字或二进制存在当作任务已投递。

当前已验证 Wave Flow 能在私有 tmux socket 中创建、输入、诊断读取和销毁受管终端会话；它不会使用或接管你默认 tmux server 的会话。默认 App Server 路径以 `initialize → thread/start → turn/start` ACK 确认首条任务，不会退回到 `codex exec` 或从终端文字推断状态；tmux viewer 仅供人工查看和交互。普通 TUI 兼容路径才会在 composer 就绪后以 bracketed paste 和原生 history 确认任务；无法确认时 Run 会 `interrupted`，而不会把任务当作已投递。

## 开发与验证

项目使用 [Bun](https://bun.sh/) 与 TypeScript：

```bash
bun run check
bun test
git diff --check
```

README 只记录当前可运行能力、命令和限制；研发路线与设计资料保留在本地开发环境中。
