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
  ├─ Fake Adapter：确定性试用与测试
  └─ Codex CLI Adapter：真实只读 Agent 节点
```

详细的设计边界见：[docs/wave-flow-design.md](./docs/wave-flow-design.md)。

## 当前功能

- 执行受信任的本地 TypeScript Workflow。
- 在运行前校验 Workflow 的 `meta` 和 `default` / `run` 入口。
- 使用 `ctx.agent()` 委派独立 Agent 任务，并输出统一的 `AgentResult`。
- 使用 `ctx.parallel()` 并行启动独立任务、等待全部完成、保持输入顺序；单项失败返回 `null`，不取消其他任务。
- 支持同一 `runId` 的 Journaled Replay：`resume` 会回放已完成节点，只重跑未完成或失败节点。
- 使用 `wave-flow run` 加载 Workflow，传入 JSON 输入，并在终端显示任务生命周期。
- 支持 `--input`、`--input-file` 和 `--cwd`。
- 支持 `fake` 和 `codex` Adapter；Codex 节点通过独立的 `codex exec --json` 运行。
- 支持 `ctx.agent<T>(..., { schema })`：Codex 通过 JSON Schema 约束输出，Runtime 使用 Ajv 二次校验后才向下游交付结构化结果。

`fake` 返回固定测试结果，不会读取代码、修改文件或调用 Codex。`codex` 使用当前机器已登录的 Codex CLI，以只读 sandbox 读取工作目录并返回 Agent 最终文本。

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
wave-flow run <workflow-file> --adapter <fake|codex> [选项]
```

最小示例：

```bash
wave-flow run examples/hello-review.ts \
  --adapter fake \
  --input '{"target":"src"}'
```

真实只读 Codex 示例：

```bash
# 需要已安装并登录 Codex CLI；Agent 可读取 target，但不会修改工作区。
wave-flow run examples/hello-review.ts \
  --adapter codex \
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
| `--adapter fake` | 使用固定结果的模拟 Agent，适合测试 CLI 与 Workflow 控制流。 |
| `--adapter codex` | 使用已登录的本机 Codex CLI；每个 Agent 节点以 read-only、ephemeral 方式独立运行。 |
| `--input '<JSON对象>'` | 直接传入 Workflow 的 `args`。必须是 JSON 对象。 |
| `--input-file <路径>` | 从 JSON 文件读取 Workflow 的 `args`。 |
| `--cwd <路径>` | Agent 工作目录；默认是执行命令时的当前目录。 |
| `--help` | 显示命令帮助。 |

`--input` 与 `--input-file` 不能同时使用。两者都省略时，Workflow 收到空对象 `{}`。

### 恢复和查看运行

每次 `run` 都会显示一个独立的 Run ID，并将 manifest 与 Journal 写到 `.wave-flow/runs/<run-id>/`。

```bash
# 查看本次运行的 Workflow、Adapter 和节点状态
wave-flow inspect <run-id>

# 恢复同一个 run：已完成节点直接回放，未完成/失败节点重新执行
wave-flow resume <run-id>
```

`resume` 只读取同一个 Run ID 的 Journal，绝不跨 run 复用结果。恢复前会检查 Workflow 源码 hash；manifest 中的 Workflow 路径和 cwd 必须仍位于当前项目内，避免恢复命令访问项目外的文件或目录。

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

可运行的并行示例：[examples/parallel-review.ts](./examples/parallel-review.ts)。

### 结构化输出

当下游逻辑需要分支或过滤时，为 Agent 提供 JSON Schema。泛型 `T` 只提供 TypeScript 提示；Runtime 会根据 `schema` 验证真实输出。

```ts
type Readiness = {
  canProceed: boolean;
  issues: string[];
};

const result = await ctx.agent<Readiness>(
  "检查是否可以继续。",
  {
    label: "readiness-check",
    schema: {
      type: "object",
      required: ["canProceed", "issues"],
      additionalProperties: false,
      properties: {
        canProceed: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
      },
    },
  },
);

if (!result.output.canProceed) {
  console.log(result.output.issues);
}
```

使用 Codex Adapter 时，wave-flow 会临时创建 `--output-schema` 所需文件，并在节点结束后自动清理。非 JSON 或不满足 Schema 的结果会触发 `agent.failed`，不会交给下游 Workflow。

当 Agent 需要报告验证结果时，建议在 Schema 中区分代码状态与执行环境限制：

```ts
verification: {
  status: "passed" | "failed" | "not_run" | "blocked_by_environment";
  reason: string;
}
```

`blocked_by_environment` 表示 Agent 因 read-only sandbox、权限或缺失依赖而无法验证，不等同于测试或代码失败。例如只读 Codex 节点可能无法创建某些测试所需的临时文件。

## 开发与验证

```bash
# TypeScript 类型检查
bun run check

# 自动化测试
bun test
```

## 当前限制

- 仅支持本地、受信任的 `.ts` Workflow；不支持 URL 或远程下载的 Workflow。
- 支持 `run`、`resume` 和 `inspect`；尚不支持 `create`、`go`。
- Codex Adapter 当前固定使用 read-only sandbox；尚不支持工作区写入、tmux 持久会话或运行中人工接管。
- 尚不支持自动修复不合格的结构化输出、从 TypeScript 类型自动生成 Schema、`ctx.assert()` 或 `ctx.ask()`。
- 尚不支持 JSONL `--print`、跨 run 缓存、脚本变化后的恢复、自动 Ctrl-C 信号处理、超时/重试/预算、Worktree 隔离写入或默认 Adapter 配置。
