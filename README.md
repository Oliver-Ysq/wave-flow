# Wave Flow

> 面向 AI Coding Agent 的动态工作流：让不同 Agent 在同一条可复用工作流中持续接力，
> 从 CLI 到本地受管会话保持长任务可控、可见、可恢复。
>
> A dynamic workflow for AI coding agents.

*受 Claude Code Dynamic Workflows 启发。*

中文 | [English](./README.en.md)

## 当前可用能力

- 使用 TypeScript 编排可复用的动态工作流；Agent 节点由 Workflow 在运行时的实际调用推进。
- 为每个 Agent 节点托管真实、长期存活且可交互的 Codex CLI 会话。
- 通过 `wave-flow run` 创建 Run，安全投递首条任务后返回 Run ID，并在当前终端订阅状态变化。
- 通过 `wave-flow inspect <run-id>` 再次读取 Run 状态。
- Agent 通过 `wave-flow complete` 上报经校验的结构化完成结果；终端文字不是完成依据。
- 本地 daemon 持久化 Run、事件、会话坐标与结果，并管理私有 tmux socket 中的受管会话。

## 当前边界

- 当前仅支持 `agent(..., { cli: "codex" })`。
- 当前面向本机单用户；daemon 仅在本机运行。
- Local Web、HITL、Replay、跨 daemon 恢复与 TraeX 尚未实现。
- 默认路径通过 Codex App Server 的 `turn/start` ACK 确认首条任务已投递；tmux 是查看和交互会话的 viewer，不以终端文本判断投递或完成。

## 快速开始

要求：已安装 [Bun](https://bun.sh/)、Codex CLI 和 tmux。

先将当前包注册到本机：

```bash
bun link
```

创建一个 Workflow。`meta.phases` 声明阶段，调用 `agent()` 前必须先用 `phase()` 选择其中一个阶段：

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

运行 Workflow：

```bash
# 可选：只确保后台 daemon 已启动，不创建 Run
wave-flow start

wave-flow run ./.wave-flow/workflows/local-check.ts --input '{"target":"src"}'

# 使用 run 输出的 Run ID 重新查看状态
wave-flow inspect <run-id>

# 查看本机能力探测结果
wave-flow capabilities --json
```

## 运行语义与限制

`run` 会输出唯一的 Run ID，并将 Run、事件、会话坐标与结果写入 `~/.wave-flow/runs/<run-id>/`。在创建 Run 与首条任务安全投递完成后，命令不会等待 Agent 完成，而是订阅 daemon 的状态流；节点开始、阻塞、完成或 Run 被中断都会显示在当前终端。

按 `Ctrl-C` 只停止观看，不会停止后台 daemon 或 Agent。之后可使用 `inspect` 再次查看同一个 Run。`start` 只确保当前用户的全局 daemon 已启动、健康并输出地址；`run` 会在需要时自动启动 daemon，因此 `start` 是可选入口。

默认路径经本机 App Server 的 `initialize → thread/start → turn/start` ACK 投递首条任务。tmux 中的 Codex 会话仅供人工查看和交互。传入 `--tmux-tui-input` 可显式启用普通 tmux TUI 的 paste/history 兼容路径；两条路径都只以 Agent 的 `wave-flow complete` 作为完成依据。无法确认投递时，Run 会标记为 `interrupted`，而不会把任务当作已投递。

`capabilities --json` 输出当前机器的三态能力快照：命令存在只表示可被探测；`unknown` 表示尚未形成环境结论；`unavailable` 表示已确认不能使用。Runtime 在启动与投递阶段继续验证 tmux、Codex 和会话状态，不会将二进制存在或终端文字误判为任务成功投递。

## 开发与验证

项目使用 Bun 与 TypeScript：

```bash
bun run check
bun test
git diff --check
```

README 仅记录当前可运行能力、命令和限制。
