# Wave Flow

> 面向 AI Coding Agent 的动态工作流：让不同 Agent 在同一条可复用工作流中持续接力，
> 从 CLI 到本地受管会话保持长任务可控、可见、可恢复。
>
> A dynamic workflow for AI coding agents.

*受 Claude Code Dynamic Workflows 启发。*

中文 | [English](./README.en.md)

## 当前可用能力

- 使用 TypeScript 编排可复用的动态工作流；Agent 节点由 Workflow 在运行时的实际调用推进。
- 默认通过独立、长期存活的本机 CLI ACP Worker session（Codex 或 Kimi）执行 Agent 节点。
- 通过 `wave-flow run` 创建 Run，安全投递首条任务后返回 Run ID，并在当前终端订阅状态变化。
- 通过 `wave-flow inspect <run-id>` 再次读取 Run 状态。
- Agent 通过 `wave-flow complete` 上报经校验的结构化完成结果；可通过 `block / answer / continue` 请求并处理人工协助；ACP 流与自然结束不是完成依据。
- daemon 重启将使当前 `running / blocked` ACP 节点耐久收敛为 `interrupted`；不会自动重发任务、交付旧 block 或认领旧 session。
- `wave-flow resume <run-id>` 由用户授权后重放调用轨迹：严格复用连续匹配的 completed 前缀，从第一个 interrupted 或不匹配节点开始创建新 attempt。
- `wave-flow pause / recover / stop <run-id>` 管理当前 daemon 内 ACP Run：暂停经 cancel 确认，恢复在同一 ACP session 新开检查现场后的继续回合，停止使 Run 进入终态。
- daemon 同源提供 Local Web 总览，展示 Run、Phase、Agent、结果和待处理的人工协助。
- 提供 Tauri 桌面端（当前 macOS Apple Silicon 构建），桌面端通过随包 bridge 安全发现或启动 loopback daemon；用户可直接查看和创建 Run。
- 本地 daemon 持久化 Run、事件、ACP 会话绑定与结果。

## 当前边界

- `agent()` 的 `cli` 支持 `"codex"` 与 `"kimi"`；对应 CLI 必须已在桌面“执行底座”中完成验证（已验证即 Worker 候选）。
- 当前面向本机单用户；daemon 仅在本机运行。
- TraeX 与 Retry 尚未实现。
- 默认 ACP Worker 使用用户在桌面“执行底座”中明确验证的本机 CLI（Codex 或 Kimi）；不随包或静默 fallback 到固定 CLI。ACP 流、turn 结束和终端文字均不作为完成依据，仍只信任 `wave-flow complete` 的 Schema 与 Journal 证据。

## 快速开始

CLI 开发要求：已安装 [Bun](https://bun.sh/)，以及 Codex CLI 或 Kimi CLI（至少其一）。

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

默认 ACP `pause` 不是操作系统级冻结：它请求当前 ACP Worker cancel，并在取消得到确认后才进入 `paused`。`recover` 不重发原 Prompt，而是在同一 ACP session 创建“检查现场后继续”的新回合。Agent 主动使用远端服务或其他方式脱离 Codex 管理的副作用，不在暂停确认的覆盖范围内。

暂停依赖当前 daemon 保留的 Workflow 调用栈；如果 daemon 在 `pausing`、`paused` 或 `recovering` 时重启，Wave Flow 会将该 Run 如实标记为 `interrupted`，不会伪造 recover。之后可由用户使用 `resume` 创建新的受控 attempt。

默认 ACP Worker 使用内置 adapter（`codex-acp` 或 `kimi-acp`）加用户明确验证的本机 runtime（已验证即 Worker 候选）；Worker 具有 Workflow 指派的完整读写权限。没有已验证 runtime、CLI 文件身份变化或版本重新验证前，Wave Flow 会在创建真实 Worker 前 fail closed，不会回退到随包 CLI。所有路径都只以 Agent 的 `wave-flow complete` 作为完成依据。无法确认投递时，Run 会标记为 `interrupted`，而不会把任务当作已投递。ACP Worker 支持同一 daemon 内 `pause → cancel → recover`。

`resume` 是单独的用户授权操作。它严格核对 Workflow 源码 hash、输入、项目目录和每次 `agent()` 调用的节点 id、顺序、cwd、CLI、sandbox、model、schema、input 与 prompt。连续匹配的 completed 节点直接返回 Journal 结果；第一个 interrupted 或不匹配节点创建新 attempt，之后的节点不再复用旧结果。

`capabilities --json` 输出当前机器的三态能力快照：命令存在只表示可被探测；`unknown` 表示尚未形成环境结论；`unavailable` 表示已确认不能使用。默认 ACP 路径在启动与投递阶段继续验证 Codex ACP 与会话状态，不会将二进制存在或 ACP turn 结束误判为任务成功投递。

## 开发与验证

项目使用 Bun 与 TypeScript：

```bash
bun run check
bun test
git diff --check
```

README 仅记录当前可运行能力、命令和限制。
