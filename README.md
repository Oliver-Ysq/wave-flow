# wave-flow

`wave-flow` 是一个面向 Codex CLI 的本地 Dynamic Workflow 运行时。

它的目标不是替代 Agent，而是把复杂任务中可预测的部分交给 TypeScript 编排，把需要阅读环境、调用工具和判断下一步的部分交给独立 Agent 执行。

```text
Skill
  └─ 提供领域知识、规范与操作惯例
       ↓
Workflow（TypeScript）
  └─ 决定顺序、并发、循环上限、重试、预算与结果传递
       ↓
Agent（独立 Codex ReAct Loop）
  └─ 阅读环境、调用工具、完成边界清晰的子任务
```

详细的首版设计见：[2026-09-29-wave-flow-design.md](./2026-09-29-wave-flow-design.md)。

## 当前研发状态

> 最后更新：2026-09-29（第二课：最小 Workflow Runtime）

当前已经完成并经自动化测试验证：

- 定义受信任本地 Workflow 的最小契约：静态 `meta` 加 `default` / `run(ctx, args)` 入口。
- 在启动 Agent 前校验 `meta`：名称必须是 kebab-case、描述必须为非空单行、阶段必须非空且不重复，并且副作用级别必须明确。
- Runtime 负责注入 `ctx.agent()`；Workflow 只能通过该接口委派 Agent，不能直接依赖具体执行器。
- `AgentAdapter` 抽象将运行时与 Agent 实现隔离；目前使用可控的 `FakeAgentAdapter` 测试运行时行为。
- 记录最小生命周期事件：`workflow.start`、`agent.started`、`agent.completed`、`workflow.end`。

尚未实现：

- 面向用户的 `wave-flow` CLI（如 `run`、`create`、`go`、`resume`、`inspect`）。
- 真实的 `codex exec --json` Adapter 与流式事件解析。
- `parallel()`、`pipeline()`、`phase()`、超时、重试和资源预算。
- JSON Schema 结构化结果、Artifact Store 与 Journaled Replay。
- 默认只读策略下的受控写入、Git Worktree 隔离，以及 Workflow Creator。

后续每完成一个经过类型检查和测试验证的研发小节，都会同步更新本节内容，不会将计划中的功能写成已实现功能。

## 快速开始

本项目使用 [Bun](https://bun.sh/) 作为 TypeScript 运行时、包管理器与测试运行器。请先安装 Bun 1.4 或更高版本。

```bash
git clone https://github.com/Oliver-Ysq/wave-flow.git
cd wave-flow
bun install
```

验证当前最小运行时：

```bash
# 静态类型检查：不生成构建产物
bun run check

# 运行自动化测试
bun test
```

预期结果：

```text
3 pass
0 fail
```

目前尚未提供可直接执行 Workflow 的用户 CLI。因此 [examples/hello-review.ts](./examples/hello-review.ts) 是供 Runtime 加载的示例模块，而不是可以直接单独运行的命令。

## 当前项目结构

```text
src/
  workflow/                    # 用户编写 Workflow 时必须遵守的协议
    types.ts                   # meta、WorkflowModule、WorkflowContext
    validation.ts              # meta 与 default/run 入口校验
  runtime/                     # 项目核心：组织一次 Workflow 如何运行
    types.ts                   # RuntimeOptions、AgentOptions、AgentResult
    runner.ts                  # WorkflowRunner：注入 ctx.agent()、委派 Adapter、记录事件
  adapters/                    # 可替换的 Agent 执行方式
    agent-adapter.ts           # Adapter 输入/输出协议
    testing/fake-agent-adapter.ts # 测试专用的受控 Agent Adapter
  events/                      # 对运行过程的观察接口与实现
    types.ts                   # WorkflowEvent、EventSink
    memory-event-sink.ts       # 当前测试用的内存事件实现
examples/
  hello-review.ts              # 最小 Workflow 示例
test/
  runtime.test.ts              # Runtime 的行为测试
```

## 开发路线

研发将沿着 Dynamic Workflow 教学文档的思路，逐步构建并验证：

1. 最小 Workflow Runtime（已完成）
2. 并发屏障 `parallel()` 与逐项流水线 `pipeline()`
3. 真实 Codex CLI Adapter
4. Journaled Replay 与 Artifact 模型
5. 资源治理、默认只读与 Worktree 写入隔离
6. `create` / `go` / `run` / `resume` / `inspect` CLI
