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
- Agent 通过 `wave-flow complete` 上报经校验的结构化完成结果；可通过 `block / answer / continue` 请求并处理人工协助；终端文字不是完成依据。
- daemon 重启后，仍存活且可验证的受管会话可继续处理 `answer / block / continue / complete`；不会自动重发任务或创建新 Agent。
- `wave-flow resume <run-id>` 由用户授权后重放调用轨迹：严格复用连续匹配的 completed 前缀，从第一个不可验证节点开始创建新 attempt。
- `wave-flow pause / recover / stop <run-id>` 管理当前受管 Run：暂停停止当前 turn 和该 thread 的受管背景终端，恢复在同一 thread 新开继续回合，停止使 Run 进入终态。
- daemon 同源提供 Local Web 总览，展示 Run、Phase、Agent、结果和待处理的人工协助。
- 提供 Tauri 桌面端（当前 macOS Apple Silicon 构建），桌面端通过随包 bridge 安全发现或启动 loopback daemon；用户可直接查看和创建 Run。
- 本地 daemon 持久化 Run、事件、会话坐标与结果，并管理私有 tmux socket 中的受管会话。

## 当前边界

- 当前仅支持 `agent(..., { cli: "codex" })`。
- 当前面向本机单用户；daemon 仅在本机运行。
- TraeX 与 Retry 尚未实现。
- 默认路径通过 Codex App Server 的 `turn/start` ACK 确认首条任务已投递；tmux 是查看和交互会话的 viewer，不以终端文本判断投递或完成。

## 快速开始

CLI 开发要求：已安装 [Bun](https://bun.sh/)、Codex CLI 和 tmux。

桌面端使用者无需手动启动 daemon 或运行 `wave-flow start`。当前可在 macOS Apple Silicon 开发环境构建应用：

```bash
bun install
bun run desktop:build
# 打开 src-tauri/target/release/bundle/macos/Wave Flow.app
```

桌面端会安全发现已有 daemon，或使用随包 Bun sidecar 启动新的 loopback daemon。关闭桌面窗口不会停止 daemon 或已运行的 Run；再次打开会重新展示用户级 Run 档案。

先将当前包注册到本机：

```bash
bun link
```

构建同源 Local Web 静态资源：

```bash
bun run web:build
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

# 输出 Local Web 地址
wave-flow web

# 优雅关闭已验证的当前用户 daemon
wave-flow close

wave-flow run ./.wave-flow/workflows/local-check.ts --input '{"target":"src"}'

# 使用 run 输出的 Run ID 重新查看状态
wave-flow inspect <run-id>

# 用户明确授权同一 Run 的调用级恢复
wave-flow resume <run-id>

# 暂停、恢复或停止当前 daemon 持有的 Run
wave-flow pause <run-id>
wave-flow recover <run-id>
wave-flow stop <run-id>

# 查看本机能力探测结果
wave-flow capabilities --json
```

当 Agent 需要人工协助时，任务 Prompt 会提供下列稳定身份参数。Agent 必须原样带上它们：

```bash
wave-flow block --need-help "说明阻塞原因和需要的帮助" \
  --run-id <run-id> --node-id <node-id> --agent-session-id <agent-session-id>

# 人类答复不会自动恢复节点
wave-flow answer <block-request-id> --value '{"approved":true}'

# 原 Agent 校验答案后自行恢复
wave-flow continue --block-request-id <block-request-id> \
  --run-id <run-id> --node-id <node-id> --agent-session-id <agent-session-id>
```

## 运行语义与限制

`run` 会输出唯一的 Run ID，并将 Run、事件、会话坐标与结果写入 `~/.wave-flow/runs/<run-id>/`。在创建 Run 与首条任务安全投递完成后，命令不会等待 Agent 完成，而是订阅 daemon 的状态流；节点开始、阻塞、完成或 Run 被中断都会显示在当前终端。

按 `Ctrl-C` 只停止观看，不会停止后台 daemon 或 Agent。之后可使用 `inspect` 再次查看同一个 Run。`start` 只确保当前用户的全局 daemon 已启动、健康并输出地址；`run` 会在需要时自动启动 daemon，因此 `start` 是可选入口。

运行 `wave-flow web` 可输出 Local Web 地址，例如 `http://127.0.0.1:<port>/`。页面仅连接本机 daemon，展示当前用户 Run 档案，并可交付 block 答案、暂停、恢复、停止或对 interrupted Run 发起显式 replay。

`web` 会输出 descriptor、heartbeat、PID 启动身份和 `/health` 的实际验证过程；`close` 只请求已验证 daemon 自己优雅退出并清理 descriptor / lock，不会直接猜测或终止任意 PID。

开发 React 页面时可运行 `bun run web:dev`；Vite 只负责前端开发预览，生产页面始终由 daemon 同源提供构建产物。

`pause` 不是操作系统级冻结：它先关闭 tmux viewer，再中断当前 App Server turn，并清理该 thread 可枚举的背景终端；只有背景终端清单为空才会进入 `paused`。`recover` 不重发原 Prompt，而是在同一 thread 创建“检查现场后继续”的新回合。Agent 主动用 `nohup`、远端服务等方式脱离 Codex 管理的进程，不在暂停确认的覆盖范围内。

暂停依赖当前 daemon 保留的 Workflow 调用栈；如果 daemon 在 `pausing`、`paused` 或 `recovering` 时重启，Wave Flow 会将该 Run 如实标记为 `interrupted`，不会伪造 recover。之后可由用户使用 `resume` 创建新的受控 attempt。

默认路径经本机 App Server 的 `initialize → thread/start → turn/start` ACK 投递首条任务。tmux 中的 Codex 会话仅供人工查看和交互。传入 `--tmux-tui-input` 可显式启用普通 tmux TUI 的 paste/history 兼容路径；两条路径都只以 Agent 的 `wave-flow complete` 作为完成依据。无法确认投递时，Run 会标记为 `interrupted`，而不会把任务当作已投递。

跨 daemon 的控制恢复只适用于旧 tmux 与 App Server thread 仍能验证的会话：答案可先保存，原 `block` 以相同请求 ID 重连后读取答案，只有 Agent 自己 `continue` 才恢复运行。它不自动发送 Codex 新回合、不重发 Prompt、不重跑节点，也不恢复 Workflow 调用栈。

`resume` 是单独的用户授权操作。它严格核对 Workflow 源码 hash、输入、项目目录和每次 `agent()` 调用的节点 id、顺序、cwd、CLI、sandbox、model、schema、input 与 prompt。连续匹配的 completed 节点直接返回 Journal 结果；第一个不可验证或 interrupted 节点创建新 attempt，之后的节点不再复用旧结果。仍可验证的旧会话不会被 resume 重跑。

`capabilities --json` 输出当前机器的三态能力快照：命令存在只表示可被探测；`unknown` 表示尚未形成环境结论；`unavailable` 表示已确认不能使用。Runtime 在启动与投递阶段继续验证 tmux、Codex 和会话状态，不会将二进制存在或终端文字误判为任务成功投递。

## 开发与验证

项目使用 Bun 与 TypeScript：

```bash
bun run check
bun test
git diff --check
```

README 仅记录当前可运行能力、命令和限制。
