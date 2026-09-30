# wave-flow：面向 Codex CLI 的动态工作流运行时

## 状态与定位

本文是 `wave-flow` 首版的设计方案。首版只支持本地运行，唯一 Agent 后端为已登录的 Codex CLI。

## 参考资料与实现依据

- [Harness 101：复刻 Dynamic Workflow（含代码）](https://my.feishu.cn/wiki/TM25wR9ozih8yRkaAVKcFjP1nMq)：本文档采用的核心范式依据，即 JavaScript 负责确定性编排，`agent()` 承担独立的 Agent/ReAct Loop，节点间通过显式结果传递上下文，并以 Journaled Replay 恢复已完成的 Agent 调用结果。
- [deerwork-ai/deer-workflow](https://github.com/deerwork-ai/deer-workflow)：首版的具体实现参考。特别参考其 Workflow 作为本地 ESM/TypeScript 模块直接加载、校验 `default` / `run` 与 `meta`、通过 `AsyncLocalStorage` 维持执行上下文，以及由 Codex CLI Agent 实现实际 Agent Loop 的处理方式。

上述文章阐明的是范式和职责边界；Deer Workflow 仓库源码用于核对具体运行时实现。`wave-flow` 会借鉴它们，但不会承诺与其 API 或内部实现完全兼容。

`wave-flow` 让用户通过自然语言生成一份任务专属的 TypeScript Workflow，审阅、保存或复用它，并将其运行成一组有边界、可恢复、彼此隔离的 Codex CLI 子 Agent。

核心分工如下：

- TypeScript 负责确定性工作：顺序、并发、Barrier、循环、预算、重试上限、过滤与数据转换。
- `ctx.agent()` 负责语义工作：独立的 Codex ReAct Loop，可读代码、调用工具并返回最终结果。

它是一个 Dynamic Workflow runtime，不是可视化 DAG 工具、通用 Agent 平台，也不是常驻多 Agent 服务。

## 产品形态

包名与 CLI 名称均为 `wave-flow`。

项目内状态目录：

```text
.wave-flow/
  config.json
  workflows/                 # 已审阅的可复用 Workflow，建议提交 Git
  generated/                 # create / go 自动生成的 Workflow 源码
  runs/<run-id>/
    manifest.json
    journal.jsonl
    events.jsonl
  artifacts/<run-id>/        # 长中间产物、原始日志、报告与 diff
```

命令：

```text
wave-flow create <需求>      # 生成 Workflow，但不执行
wave-flow run <文件>         # 执行已审阅 Workflow
wave-flow go <需求>          # 生成、校验、落盘并执行
wave-flow resume <run-id>    # 回放完成节点，继续未完成节点
wave-flow inspect <run-id>   # 查看 manifest、节点、回放和失败信息
```

`go` 不会隐藏或丢弃临时 Harness。生成的文件始终保留在 `.wave-flow/generated/`，验证有效后可移至 `.wave-flow/workflows/` 进行长期维护和复用。

## 首版明确不做的事情

- Claude、Pi、Responses API 或远程 Provider 等其他后端。
- 云端服务、持久任务队列、跨机器协作与通用长期记忆。
- 可视化图编辑器、自动合并 Worktree、外部副作用事务。
- `danger-full-access` 权限。
- 通用的第三方不可信 Workflow 托管与脚本沙箱服务。

## 总体架构

```text
自然语言需求 / Workflow 文件
  -> CLI
  -> Creator（仅 create / go）
  -> 源码策略与 meta 校验
  -> Runtime
       -> Scheduler
       -> Journal 与 Artifact Store
       -> Codex CLI Adapter
  -> 事件流（TTY 或 JSONL）
```

源码结构：

```text
src/
  cli/                 # 命令解析、TTY 与 JSONL 输出
  creator/             # Codex 生成 Workflow、源码校验
  runtime/             # 加载 Workflow、执行上下文、宿主 API 注入
  scheduler/           # 并发、超时、重试、预算
  adapters/codex-cli/  # codex exec --json 生命周期和事件解析
  journal/             # 追加记录、索引、输入哈希、回放
  artifacts/           # 大产物外置与校验和
  events/              # 生命周期事件、JSONL / TUI writer
skills/workflow-creator/
examples/
```

模块边界：

- `runtime` 理解 Workflow 契约，但不知道 Codex 如何被启动。
- `adapter` 将一次 Agent 调用转为一次独立 `codex exec --json` 进程，但不理解 Workflow 拓扑。
- `scheduler` 只控制资源，不解释 Prompt 语义。
- `journal` 只缓存已经成功完成的 Agent 结果；它不是 VM 快照，也不回滚文件或外部副作用。
- `creator` 只生成与校验源码，不能独立执行 Workflow。

## Workflow 文件契约与加载模型

Workflow 是 TypeScript 文件，包含静态 `meta` 导出和默认异步处理函数。首版对齐 Deer Workflow 的实际模型：Workflow 被视为受信任的本地 ESM/TypeScript 扩展模块，而不是要运行任意第三方恶意脚本的沙箱输入。

加载链路：

```text
Workflow 路径解析
  -> 直接 ESM import() 加载模块
  -> 校验 default 或 run 是否为函数
  -> 校验 meta 格式
  -> 在 AsyncLocalStorage 执行上下文中调用 run(ctx, args)
```

`meta` 是静态导出，并在调用前校验：`name` 使用 kebab-case、`description` 为非空单行、phase 非空且不重复，`exampleArgs` 必须可 JSON 序列化。

信任边界与 Deer 一致：Workflow 可以是用户在当前项目中维护的源码，也可以是当前已登录 Codex 通过 `create` / `go` 生成后落盘的源码；首版不承诺安全执行来自第三方下载地址或未知来源的 Workflow。

脚本负责并发、循环、分支、聚合和上游结果传递；`ctx.agent()` 才启动完整 Agent Loop，并经由 Codex sandbox 产生真实工具副作用。安全控制重点在 Agent 执行层，而非将 Workflow 当作不可信 JavaScript 沙箱运行。

```ts
export const meta = {
  name: "auth-review",
  description: "从多个独立视角审查认证模块。",
  phases: ["discover", "review", "synthesize"],
  exampleArgs: { target: "src/auth" },
  sideEffects: "none" as const,
};

export default async function run(ctx: WorkflowContext, args: { target: string }) {
  const findings = await ctx.phase("review", () =>
    ctx.parallel([
      () => ctx.agent(`审查 ${args.target} 的安全问题。`, {
        label: "security-review", sandbox: "read-only",
      }),
      () => ctx.agent(`审查 ${args.target} 的正确性问题。`, {
        label: "correctness-review", sandbox: "read-only",
      }),
    ]),
  );
  return ctx.agent(
    `汇总以下审查结果：${JSON.stringify(findings.filter(Boolean))}`,
    { phase: "synthesize", sandbox: "read-only" },
  );
}
```

`meta` 必须是静态可读取的字面量，用于声明展示名称、描述、阶段、示例输入和副作用级别。

## 运行时 API

```ts
type AgentOptions = {
  label?: string;
  phase?: string;
  schema?: object;
  model?: string;
  sandbox?: "read-only" | "workspace-write";
  cwd?: string;
  isolation?: "shared" | "worktree";
  timeoutMs?: number;
  retries?: number;
  nodeKey?: string;
};

type AgentResult<T = string> = {
  output: T;
  usage?: { inputTokens?: number; outputTokens?: number };
  replayed: boolean;
  runId: string;
};

interface WorkflowContext {
  agent<T = string>(prompt: string, options?: AgentOptions): Promise<AgentResult<T>>;
  parallel<T>(tasks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline<T>(
    items: T[],
    ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown>>
  ): Promise<Array<unknown | null>>;
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  log(message: string, data?: unknown): void;
  assert(prompt: string, options?: Omit<AgentOptions, "schema">): Promise<boolean>;
  now(): number;
  random(): number;
  budget: { remaining(): number | null; spent(): number; exhausted(): boolean };
}
```

语义：

- `agent()` 是唯一直接面对 LLM 的原语；每次调用都会创建独立上下文的 Codex CLI 执行。
- 指定 `schema` 时，只有解析并通过校验后才返回结构化 `output`。
- `parallel()` 受全局并发限制，保留输入顺序；单项失败转为 `null`，不会取消兄弟节点。
- `pipeline()` 允许每个 item 独立流过多个 stage；一项失败只中断它自己，最终值为 `null`。
- `phase()` 是逻辑分组和可观测性边界；禁止在并发分支内切换 phase，避免状态竞争。
- `assert()` 是返回布尔值的 schema 化 Agent 调用，用于显式决定循环是否停止。
- `now()`、`random()` 是带种子的确定性值。Workflow 不应使用环境时间或随机数决定调度路径。

## 上下文与 Artifact 模型

各个子 Agent 不共享对话记录。上下文通过显式结果传递：

```text
Agent 输出 -> TypeScript 变量 -> 下游 Prompt 或 Artifact 引用
```

小型 JSON 结果（默认阈值 32 KB）可以内嵌到后续 Prompt 和 journal。长报告、原始日志和 diff 写入 `.wave-flow/artifacts/<run-id>/`。Journal 仅保存 Artifact 路径、SHA-256 和简要摘要；下游 Agent 得到路径与“按需读取”的指令。

Artifact 是单次运行的执行证据，不是跨运行的隐式记忆。

## Codex CLI Adapter

每次未命中的 `ctx.agent()` 都会变成一个独立、临时的 `codex exec --json` 子进程。Adapter 的职责：

1. 解析 `cwd`、sandbox、model、输出 schema 与 worktree。
2. 获取 Scheduler 槽位。
3. 写入 `agent.started` journal。
4. 流式解析 Codex JSON 事件。
5. 提取最终结果和可获得的 usage。
6. 按请求的 schema 校验输出。
7. 将完成结果可靠落盘后，再返回 Runtime。

首版直接使用用户当前的 Codex CLI 登录态，不依赖 OpenAI API Key 或 Codex SDK。

## 调度、重试与预算

项目默认配置保守且显式：

```json
{
  "concurrency": 4,
  "budget": { "maxNodes": 24, "maxTokens": 120000 },
  "defaultSandbox": "read-only"
}
```

Scheduler 负责全局信号量、最大节点数、Token 预算、单节点超时、有限重试和退避。每次尝试均产生 journal 与事件记录。超时、进程失败、结构化输出不合法或取消都不能形成可缓存的完成记录。

预算耗尽时，默认明确失败而不是悄悄返回部分成功；未来可通过配置引入 `skip` / `downgrade` 等策略。

## Journaled Replay：可恢复语义

每个 run 都有 append-only JSONL journal，例如：

```json
{"event":"agent.started","nodeKey":"security-review","inputHash":"..."}
{"event":"agent.completed","nodeKey":"security-review","inputHash":"...","output":{},"usage":{}}
```

`resume` 会重新执行 Workflow 源码，并在每个 Agent 调用处查询 journal：完全匹配的 completed 记录立刻返回缓存结果；进行中、失败、超时或输入变化的调用则再次执行。它不保存 JavaScript 内存或调用栈。

回放 Key 包含：Workflow 源码 hash、稳定调用标识（优先 `nodeKey`，否则结构位置）、prompt、schema、model、sandbox、解析后的 `cwd`、isolation，以及已消费上游结果的 hash。上游计划或结果变化时，依赖它的汇总节点会失效；无关节点仍可以复用。

默认严格恢复要求 Workflow 源码和输入都不变。`--allow-script-change` 允许修改源码后继续运行，但只有完整回放 Key 仍相同的节点才能命中缓存。

## 写入安全与隔离

默认 sandbox 为 `read-only`。写入必须同时满足：

- `sandbox: "workspace-write"`；
- 显式提供 `cwd`；
- `meta.sideEffects: "workspace"`；
- 显式声明 isolation 策略。

并发写节点不能共享同一工作区，必须使用 `isolation: "worktree"`。Runtime 创建独立 Git Worktree，记录路径、基线 commit、最终 diff 和可选 commit。首版绝不自动合并 Worktree。

写入前，Runtime 记录 Git HEAD 和工作区 dirty 状态。执行生成的 Workflow 前，CLI 展示计划中申请的 sandbox 与目标目录。副作用不是可回放事务：Prompt 应描述目标状态而非追加操作，外部 API 不纳入 P0。

Workflow 作为受信任本地模块直接加载，但真实读写能力始终由 `ctx.agent()` 的 Codex sandbox 决定。默认只读，写入需要显式声明、明确 `cwd`，并发写入通过 Worktree 隔离。

## 事件与可观测性

所有生命周期信息以 typed JSONL event 输出，至少包括：

```text
workflow.start / workflow.meta / workflow.end / workflow.error
phase.start / phase.end
agent.queued / agent.started / agent.retry / agent.completed / agent.failed
artifact.created
log
```

`--print` 将纯 JSONL 输出至 stdout，供 CI 消费。交互模式基于同一事件流展示最小 TUI：阶段、活跃节点、回放节点与失败情况。

## CLI MVP：先验证本地运行闭环

在完整的 Codex CLI Adapter、JSONL Writer 和配置系统完成前，先提供一个面向开发与试用的 `run` 命令。它只组装现有 Runtime，不复制 Workflow 的校验或编排逻辑。

本地开发期也使用正式命令名，而不是要求用户记忆源码启动命令：

```bash
# 首次在当前项目执行；Bun 将本地源码注册为 wave-flow 命令。
bun link

wave-flow run examples/hello-review.ts \
  --adapter fake \
  --input '{"target":"src"}'
```

`package.json` 通过 `bin` 将 `wave-flow` 指向 Bun 可直接执行的 CLI 入口。链接后每次运行仍读取当前项目源码，修改实现后不需要重复 `bun link`。未来发布包后，命令形式保持不变。

MVP 命令契约：

```text
wave-flow run <workflow-file> --adapter fake [--input <json> | --input-file <path>] [--cwd <path>]
```

- `run` 是 MVP 唯一支持的子命令。
- `<workflow-file>` 只能是用户明确指定的本地 `.ts` 文件；不支持 URL、Git 仓库地址或自动下载的第三方 Workflow。Workflow 是受信任本地模块，加载时可能执行模块顶层代码。
- `--adapter fake` 在 Fake 阶段必填，避免用户误以为命令已调用真实 Codex。后续接入 Codex 后会提供 `--adapter codex` 与项目默认 Adapter 配置。
- `--input` 与 Deer Workflow 的社区实践对齐，接收一个 JSON 对象并原样传为 `run(ctx, args)` 的 `args`。CLI 不推断 Workflow 的业务字段或类型。
- `--input-file` 从 JSON 文件读取同样的对象，避免复杂输入受 shell 引号影响。
- 输入参数二选一；均未提供时 `args` 为 `{}`；JSON 根节点必须是对象。
- `--cwd` 是 Agent 工作目录，省略时使用运行命令时的当前目录。

CLI 处理边界：

```text
命令行
  -> 解析 run / 路径 / 输入 / cwd / adapter
  -> 检查并 import() 本地 TypeScript Workflow
  -> 创建 FakeAgentAdapter、TerminalEventSink、WorkflowRunner
  -> runner.run(workflow, args)
  -> 显示最终结果或清晰错误并返回非零退出码
```

CLI 仅负责路径、输入和组件装配；`meta` 与 `default` / `run` 入口仍只由 Runtime 校验，避免规则重复。终端输出消费既有 `WorkflowEvent`，以人类可读形式展示 `workflow.start`、`agent.started`、`agent.completed`、`workflow.end` 与 `workflow.error`。后续 `--print` 只需替换事件接收器为 JSONL Writer，不应修改 Runner。

本阶段目录边界：

```text
src/cli/
  main.ts               # 进程入口、统一错误处理与退出码
  parse-run-command.ts  # 解析 run 命令与输入选项，不执行 Workflow
  load-workflow.ts      # 路径检查和动态 import() 本地 .ts Workflow
  terminal-events.ts    # WorkflowEvent 到终端进度文本
  output.ts             # 最终结果与格式化错误输出
```

CLI MVP 不包含真实 Codex Adapter、`pipeline()`、`--print` JSONL、`use` / `.wave-flow/config.json`、`create`、`go`、`resume` 或 `inspect`。这些能力会在 Runtime 和 Adapter 的对应课程完成后渐进加入。

## P0 范围与验收

| 能力 | 验收标准 |
| --- | --- |
| Workflow Runner | 可运行手写的 `agent`、`parallel`、`pipeline`、`phase`、`log` 脚本。 |
| Codex Adapter | 每个 Agent 是独立 `codex exec --json`；能采集终态结果和错误。 |
| Schema 契约 | 非法 JSON 或 schema 不通过时节点失败，结果不可缓存。 |
| 资源控制 | 并发、超时、重试、节点/Token 限额均真正生效并体现在事件中。 |
| Replay | 中断后重跑时复用已完成节点，未完成节点重新执行。 |
| 动态创建 | `create` / `go` 利用内置 Creator Skill 生成、落盘、校验并按需执行。 |
| 默认安全 | 除非明确声明并通过校验，否则不发生写入。 |
| 机器输出 | CI 可消费完整 JSONL 事件流。 |

端到端验收用例：

1. 多视角只读代码审查：并发审查后由汇总 Agent 整合。
2. 根因排障：独立提出假设、核验证据，并通过有上限的断言循环收敛。
3. 独立修复：多个 Worktree Agent 修复独立文件，产出 diff，但不自动合并。

## P1 后续能力

- 更完整的终端 UI 与 `inspect` 汇总。
- 已保存 Workflow registry，以及一层 `workflow()` 组合。
- 静态 linter：发现不可回放循环、并发写冲突、动态循环中缺失 `nodeKey`、未处理 `null` 输出等问题。
- Builder / Verifier 模板、dry-run 计划和更强的 Creator 指导。

## 设计理由

本设计吸收 Deer Workflow 的小型、代码优先 API 面，也吸收 codex-flow 的有界执行、结构化结果和节点级 journal replay。核心仍是 Dynamic Workflow 的范式：强 Agent 为本次任务生成专属 Harness，确定性的代码再去编排多个隔离的 Agent Loop。

首版刻意不把它扩张为通用编排平台，先验证这个核心闭环是否真正有价值。
