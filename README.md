# wave-flow

`wave-flow` 是一个面向本地 Coding Agent 的 Dynamic Workflow 运行时。你用 TypeScript 写清楚任务的顺序、并发关系和结果传递；每个 `ctx.agent()` 则由可替换的 Agent Adapter 执行。

```text
Workflow（TypeScript）
  ├─ 决定先后顺序、并发和结果传递
  └─ 调用 ctx.agent() 提交语义任务
            ↓
Workflow Runner
  ├─ 校验 Workflow
  ├─ 记录生命周期事件
  └─ 调用 Agent Adapter
            ↓
Agent Adapter
  └─ 当前：Fake Adapter；未来：Codex CLI
```

详细的设计边界见：[2026-09-29-wave-flow-design.md](./2026-09-29-wave-flow-design.md)。

## 当前功能

- 执行受信任的本地 TypeScript Workflow。
- 在运行前校验 Workflow 的 `meta` 和 `default` / `run` 入口。
- 使用 `ctx.agent()` 委派独立 Agent 任务，并输出统一的 `AgentResult`。
- 使用 `ctx.parallel()` 并行启动独立任务、等待全部完成、保持输入顺序；单项失败返回 `null`，不取消其他任务。
- 使用 `wave-flow run` 加载 Workflow，传入 JSON 输入，并在终端显示任务生命周期。
- 支持 `--input`、`--input-file` 和 `--cwd`。

当前唯一可用 Adapter 是 `fake`。它返回固定测试结果，不会读取代码、修改文件或调用 Codex。

## 安装与本地链接

本项目使用 [Bun](https://bun.sh/) 运行 TypeScript、安装依赖和执行测试。请安装 Bun 1.4 或更高版本。

```bash
git clone https://github.com/Oliver-Ysq/wave-flow.git
cd wave-flow
bun install

# 将当前项目注册为本机的 wave-flow 命令；每台机器首次执行一次即可。
bun link
```

之后在项目目录中可直接使用 `wave-flow`。修改源码后无需再次执行 `bun link`。

## 运行 Workflow

```bash
wave-flow run <workflow-file> --adapter fake [选项]
```

最小示例：

```bash
wave-flow run examples/hello-review.ts \
  --adapter fake \
  --input '{"target":"src"}'
```

示例输出：

```text
▶ Workflow started: hello-review
  Run ID: <run-id>
  → Agent started: initial-review
  ✓ Agent completed: initial-review
✓ Workflow completed: hello-review

Result:
{
  "output": "No critical findings.",
  "replayed": false,
  "runId": "<run-id>"
}
```

### 命令选项

| 选项 | 说明 |
| --- | --- |
| `--adapter fake` | 当前必填。明确使用 Fake Adapter，避免误以为已调用真实 Codex。 |
| `--input '<JSON对象>'` | 直接传入 Workflow 的 `args`。必须是 JSON 对象。 |
| `--input-file <路径>` | 从 JSON 文件读取 Workflow 的 `args`。 |
| `--cwd <路径>` | Agent 工作目录；默认是执行命令时的当前目录。 |
| `--help` | 显示命令帮助。 |

`--input` 与 `--input-file` 不能同时使用。两者都省略时，Workflow 收到空对象 `{}`。

复杂输入建议放在 JSON 文件中，避免 shell 引号问题：

```json
{
  "target": "src/auth"
}
```

```bash
wave-flow run examples/hello-review.ts \
  --adapter fake \
  --input-file inputs/review.json
```

## 编写 Workflow

Workflow 是一个本地 `.ts` 模块，必须导出静态 `meta`，并导出默认 `run` 函数或命名 `run` 函数。

```ts
import type { WorkflowContext, WorkflowMeta } from "../src/workflow/types";

export const meta: WorkflowMeta = {
  name: "hello-review",
  description: "Review one target with a single agent.",
  phases: ["review"],
  sideEffects: "none",
};

export default async function run(
  ctx: WorkflowContext,
  args: { target: string },
) {
  return ctx.agent(`Review target: ${args.target}`, {
    label: "initial-review",
  });
}
```

`meta.name` 必须是 kebab-case；`description` 必须为非空单行；`phases` 不能为空且不能重复；`sideEffects` 当前允许 `none` 或 `workspace`。

### 并行任务

当多个任务互不依赖、但下游需要等待全部结果时，使用 `ctx.parallel()`：

```ts
const reviews = await ctx.parallel([
  () => ctx.agent("Review security", { label: "security" }),
  () => ctx.agent("Review correctness", { label: "correctness" }),
]);

// reviews 按输入顺序返回；失败的任务位置为 null。
return reviews;
```

## 开发与验证

```bash
# TypeScript 类型检查
bun run check

# 自动化测试
bun test
```

## 当前限制

- 仅支持本地、受信任的 `.ts` Workflow；不支持 URL 或远程下载的 Workflow。
- 仅支持 `wave-flow run`；不支持 `create`、`go`、`resume`、`inspect`。
- 仅支持 `fake` Adapter；真实 Codex CLI Adapter 尚未接入。
- 尚不支持 JSONL `--print`、输入 schema、断点恢复、超时/重试/预算、Worktree 隔离写入或默认 Adapter 配置。
