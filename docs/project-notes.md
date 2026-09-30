# wave-flow 项目笔记

> 本文记录项目的关键设计、架构演进、问题复盘与答辩准备材料。它不是面向使用者的 README，也不替代 [设计规格](./wave-flow-design.md)。

## 1. 项目定位与核心决策

### 1.1 为什么需要 Dynamic Workflow

**设计决定：** 用 TypeScript 固化确定性控制流，用独立 Agent 处理需要语义判断和工具调用的子任务。

```text
Workflow（顺序、并发、结果传递）
        ↓
Runner（校验、运行边界、事件）
        ↓
Adapter（具体 Agent 后端）
        ↓
Agent（ReAct Loop 与工具调用）
```

**原因：** 复杂任务不能可靠地只靠一个长 Prompt 记住“先做什么、哪些并行、何时汇总”；但把代码库理解、证据判断等开放式问题全部硬编码，又会失去 Agent 的价值。Dynamic Workflow 将这两类职责分开。

**已验证事实：** 当前单元测试已验证 Workflow 通过受控 `ctx.agent()` 委派任务、Runner 统一记录生命周期事件、Adapter 可替换，且 `parallel()` 能稳定处理并行屏障。

**已知限制：** 尚未接入真实 Codex CLI，因此尚未证明真实 Agent 子进程、流式事件、超时和模型失败时的行为。

### 1.2 为什么 Workflow 是受信任本地 TypeScript 模块

**设计决定：** 首版通过 Bun 动态加载用户明确指定的本地 `.ts` Workflow，不尝试将任意 JavaScript 作为不可信脚本沙箱化。

**原因：** Workflow 的价值正来自正常 TypeScript 的控制流、数据转换与组合能力。为不可信第三方代码构建安全 JS 沙箱是另一项大型产品能力，不能与首版运行时混在一起。

**边界：** CLI 只接受本地 `.ts` 路径，不支持 URL、自动下载或 Git 仓库地址。模块顶层代码仍可能执行，所以“本地明确指定”不等同于“安全”。

### 1.3 为什么先实现 Fake Adapter

**设计决定：** 先用 `FakeAgentAdapter` 验证 Runner、事件、CLI、输入和并发语义，再单独接入真实 Codex Adapter。

**原因：** 真实 Agent 的登录态、网络、模型输出和子进程事件会带来不稳定性。若一开始混入，无法判断失败来自 Runtime 还是 Codex CLI。

**已验证事实：** Fake Adapter 让测试能稳定断言 `prompt`、`label`、`cwd`、事件顺序和并行行为；CLI 已可完整跑通 `wave-flow run` 链路。

**已知限制：** Fake Adapter 返回固定文本，不读取代码、不调用工具、不代表真实 Agent 能力。对外说明必须明确它不是 Codex。

## 2. 当前架构与调用链

### 2.1 目录职责

```text
src/
  workflow/   Workflow 文件的协议与校验
  runtime/    一次运行的生命周期和 ctx API
  adapters/   Agent 后端抽象及实现
  events/     运行事件协议及输出端
  cli/        命令解析、输入/路径处理和组件装配
```

**关键边界：**

- `workflow/` 描述“用户写的任务长什么样”，不创建子进程。
- `runtime/` 描述“任务如何运行”，不理解 Prompt 的业务含义。
- `adapters/` 描述“Agent 如何实际执行”，不理解 Workflow 的拓扑。
- `cli/` 只组装组件，不复制 `meta` 或入口校验规则。

### 2.2 当前运行链路

```text
wave-flow run <workflow.ts>
  -> 解析 --adapter / --input / --cwd
  -> 动态加载本地 Workflow
  -> WorkflowRunner.run(workflow, args)
  -> createWorkflowContext(...)
  -> ctx.agent() / ctx.parallel()
  -> AgentAdapter.execute(...)
  -> EventSink 输出生命周期
```

**当前可用命令：**

```bash
wave-flow run examples/hello-review.ts \
  --adapter fake \
  --input '{"target":"src"}'
```

开发期通过一次 `bun link` 注册本地 `wave-flow` 命令，避免让使用者依赖 `bun run dev` 这种内部启动方式。

## 3. 难点、取舍与解决方案

### 3.1 `parallel()` 为什么不在第一个失败时整体抛错

**问题：** 多视角审查中，一个 Agent 失败是否应取消其他 Agent？

**设计决定：** `ctx.parallel()` 使用类似 `Promise.allSettled()` 的语义：所有任务立即启动，等待全部结束；成功结果按输入顺序返回，失败位置返回 `null`。

**原因：** 安全审查失败时，正确性审查的结果仍有价值。取消兄弟任务会无谓丢失已有或即将完成的证据。

**验证证据：** 测试覆盖了“任务不同顺序完成，输出保持输入顺序”“一个任务失败不取消其余任务”“下游必须等待所有任务结束”。

**代价：** 下游 Workflow 必须显式处理 `null`；目前还没有静态检查来提醒使用者这一点。

### 3.2 为什么 `parallel()` 接收任务函数而不是 Promise 数组

**设计决定：** API 是 `ctx.parallel([() => taskA(), () => taskB()])`，而不是传已创建的 Promise。

**原因：** 任务函数是尚未启动的工作单元。未来 Scheduler 才能在启动前施加并发上限、预算、超时、重试、取消或 Journal 回放；如果用户先创建 Promise，Runtime 已失去调度权。

**当前限制：** 尚未引入 Scheduler，所以当前 `parallel()` 会立即启动全部任务；大批量任务的并发控制仍待实现。

### 3.3 CLI 输入为什么使用 `--input` JSON 对象

**设计决定：** 与 Deer Workflow 的社区 CLI 实践对齐：`run <workflow> --input '<JSON>'`，并增加 `--input-file` 处理复杂输入。

**原因：** 每份 Workflow 的 `args` 形状、字段和类型都不同。让运行时自动支持 `--target`、`--issue` 等业务 flag，需要额外的 schema、转换和帮助系统，会把 Workflow 的业务模型耦合进 CLI。

**替代方案与取舍：**

- `--key value`：手动体验更轻，但无法在没有输入 schema 的情况下可靠校验类型、数组和嵌套对象。
- 仅 `--input`：通用但 shell 引号体验差。
- 当前方案：保留通用 JSON，复杂数据使用 `--input-file`，将 shell 复杂度降到可接受范围。

### 3.4 为什么 Fake Adapter 必须显式指定

**设计决定：** CLI MVP 要求 `--adapter fake`，而不是静默默认 Fake。

**原因：** 如果命令默认返回固定文本，使用者可能误以为已经触发真实 Codex 审查。显式 flag 让模拟状态在命令层可见。

**后续演进：** 等真实 Codex Adapter 存在后，引入 `wave-flow use <adapter>` 写入项目配置；优先级应是命令行显式参数 > 项目默认值 > 内置默认值。

## 4. 答辩与面试质询库

### Q1：这不就是普通的多 Agent 框架吗？

**短答：** 不是。重点不是让多个 Agent 自由聊天，而是让审阅过的 TypeScript 明确控制顺序、并发、失败隔离和上下文传递，Agent 只在边界清晰的节点内完成语义工作。

**追问准备：** 当前实现已经验证了 Runner/Adapter 分层和 `parallel()` 屏障；Journal、预算和真实 Codex 是后续能力，不能宣称已经具备。

### Q2：为什么不让一个强 Agent 自己规划并完成全部工作？

**短答：** 强 Agent 适合判断和探索，但不适合承担需要稳定复现的机械控制流。将并发、等待和结果聚合写进代码后，流程更可审阅、可测试，也更容易恢复。

**局限：** Workflow 设计不佳仍会限制 Agent；不是把流程写成 TypeScript 就自动提高任务质量。

### Q3：Adapter 抽象是否过度设计？

**短答：** 它只有一个 `execute(input)` 接口，却隔离了 Runtime 与真实 Agent 进程。没有它，CLI、测试和 Runtime 会直接依赖 Codex；测试变慢且不稳定，未来替换后端需要穿透修改多个模块。

**证据：** 当前 Fake Adapter 已用于稳定测试与 CLI 试用；真实 Codex 可作为新增 Adapter 接入，不需要改 WorkflowRunner 的编排逻辑。

### Q4：为什么 `parallel()` 失败时返回 `null`，而不是抛错？

**短答：** 并行分支通常是独立证据源。一条失败不应取消其余有价值的结果；`null` 把失败显式交给下游决定如何降级或报告。

**风险：** 下游若忽略 `null` 会产生错误汇总。后续静态 linter 应检测未处理的可空结果。

### Q5：为什么不从第一天就接入真实 Codex？

**短答：** 先用 Fake Adapter 将 CLI、输入、事件、Runner 和并发语义变成确定性、可测试的闭环；否则真实 Agent 的登录、网络、模型和子进程噪声会掩盖运行时缺陷。

**承认的缺口：** 这不等于真实 Codex 已被验证；真实 Adapter 必须单独加入集成测试和失败处理验证。

### Q6：为什么 Workflow 允许动态 import 本地 TypeScript，这不会有安全风险吗？

**短答：** 有风险，所以首版将它明确限定为用户指定的、受信任的本地模块；不支持 URL、下载或第三方托管。完整的 JavaScript 沙箱是独立问题，不假装已经解决。

**后续方向：** Agent 工具层的 sandbox、写入声明与 Worktree 隔离负责控制真实副作用；它们不等同于 JavaScript 模块沙箱。

## 5. 当前状态快照

### 已验证

- Workflow `meta` 与入口校验。
- `ctx.agent()` 的统一 Adapter 委派、结果包装和生命周期事件。
- `ctx.parallel()` 的并行启动、顺序保持、失败隔离与屏障等待。
- Fake Adapter 下的 `wave-flow run`、`--input`、`--input-file`、`--cwd`、终端事件输出。
- Bun 类型检查和自动化测试。

### 未实现或未验证

- 真实 Codex CLI Adapter 与 `codex exec --json` 事件解析。
- `pipeline()`、`phase()`、Scheduler、并发上限、超时、重试和预算。
- JSONL `--print`、Artifact、Journaled Replay、`resume`、`inspect`。
- 写入安全、Worktree 隔离、`create` / `go`、`use` 默认 Adapter 配置。
