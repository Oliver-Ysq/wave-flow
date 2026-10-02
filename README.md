# Wave Flow

Wave Flow 是一个面向本机单用户的动态工作流产品：用户将以 TypeScript 编排任务，每个 Agent 节点最终会托管一个真实、长期存活、可交互的 Codex 或 Claude Code CLI 会话。本地 CLI 与 Web 控制台会共同管理 daemon。

## 当前状态

项目已完成旧一次性 `codex exec` Runtime 的移除，并按职责建立源码边界。当前可使用 `run` 与 `inspect` 验证 Workflow、Run 状态机与 Journal；该路径使用确定性开发验证执行器，**不会**启动 tmux、Codex、Claude 或其他真实 Agent。正常交互式 CLI、Local Web、HITL、Replay 与 Adapter 仍未实现。

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

运行并查看结果：

```bash
wave-flow run ./workflow.ts --input '{"target":"src"}'
wave-flow inspect <run-id>
```

`run` 会输出唯一的 RunId，并将 Run、事件与结果写入当前项目的 `.wave-flow/runs/`。当前结果来自确定性开发验证执行器，不会使用 `cli: "codex"` 启动 Codex；该字段仅验证 Workflow 节点契约。

## 开发与验证

项目使用 [Bun](https://bun.sh/) 与 TypeScript：

```bash
bun run check
bun test
git diff --check
```

README 只记录当前可运行能力、命令和限制；研发路线与设计资料保留在本地开发环境中。
