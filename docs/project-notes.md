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

### 3.5 为什么 Codex 节点首版不用 tmux

**设计决定：** 每次 `ctx.agent()` 直接启动独立的 `codex exec --json --ephemeral --sandbox read-only` 子进程，而不是通过 tmux 或 PTY 维持会话。

**真实协议证据：** 已实际运行最小只读命令并观察 stdout JSONL：先出现 `thread.started`、`turn.started`，最终回答为 `item.completed` 且 `item.type` 为 `agent_message`，最后出现带 token 统计的 `turn.completed`。stderr 会出现与状态库、插件相关的警告，因此必须和 stdout JSONL 分开处理。

**原因：** wave-flow 当前的节点模型需要独立上下文、明确退出边界和未来的节点级 Journal Replay。Codex 的非交互 `exec --json` 已直接满足这一模型。tmux 更适合 BotMux 一类的长驻会话：人工 attach、连续追问、移动端接管和终端复连。

**最脆弱假设：** `item.completed.agent_message` 与 `turn.completed` 的事件形状会在 Codex CLI 版本间保持足够稳定。Adapter 必须只依赖最小字段、对未知事件忽略、对无最终消息或非法 JSONL 明确失败，并在升级 Codex 时运行集成验证。

**不做什么：** 首切片不把 Codex 工具事件暴露成公共事件，不支持写入 sandbox、tmux 持久会话或运行中人工接管。

### 3.6 真实 Adapter 审查暴露的三个运行边界

**问题来源：** 首次使用真实 Codex 对 Adapter 实现进行审查，发现 Fake Adapter 单元测试无法覆盖的三个缺陷。

**修复 1：节点失败事件。** `ctx.agent()` 在 Adapter 抛错时先发出 `agent.failed`（携带 `label` 与错误文本），再原样抛出，使 Runner 继续发出外层 `workflow.error`。这区分了“哪个节点失败”和“整次运行失败”；并行任务、终端输出和未来 Journal 都依赖这一层次。

**修复 2：Prompt 选项注入。** Codex 命令在 prompt 前加入独立的 `--`。否则 `ctx.agent("--help")` 会被 CLI 当作参数而不是任务内容。已用真实只读 Codex 验证：以 `--help` 开头的 Prompt 仍返回 Agent 输出 `OK`。

**修复 3：输出内存上界。** Adapter 改为流式读取 stdout JSONL，仅保留最后一条 `agent_message`；stderr 在读取时限制为 800 个字符。不能先用 `Response(...).text()` 把复杂任务的完整工具输出载入内存，再事后截断。

**刁钻考官追问：** “为什么测试没有一开始发现？”

**诚实回答：** Fake Adapter 测试验证的是 Runtime 的确定性编排语义，不能证明真实 CLI 的参数解析、输出规模和事件协议边界。真实 Agent 集成测试是必要的第二层证据；本次审查正证明了分层测试不能互相替代。

### 3.7 为什么 `codex exec` 不能直接使用当前桌面的 Browser Use

**复现命令：**

```bash
codex exec --sandbox workspace-write \
  "使用 browser use 打开 https://www.baidu.com/，截图核验布局"
```

**观察结果：** Codex 能启动，但其独立进程中的 `cua_repl` 调用失败，最终报告“内置浏览器不可用，Chrome 未获授权”。这不是 `workspace-write` 失败，也不是网页访问失败。

**根因：能力宿主不同。** `workspace-write` 只决定 Agent 生成的文件和终端命令可写哪些目录；它不授予浏览器、截图、桌面辅助功能或当前聊天窗口 Tab 的控制权。当前桌面对话中的 Browser Use 由桌面应用维护一份已连接的浏览器/计算机控制会话；`codex exec` 是新建的无交互子进程，默认不继承这个会话句柄、浏览器扩展连接或用户授权。

```text
当前桌面对话
  -> 已连接的 Browser Use / 当前浏览器 Tab

独立 codex exec
  -> 新进程、独立工具宿主
  -> 没有桌面对话的浏览器会话与授权
```

**为什么不能简单把权限设为 workspace-write：** 文件 sandbox、网络访问、浏览器控制和截图属于不同能力域。即使进程可写项目目录，也不应因此能控制用户已登录浏览器、读取页面、截图或代表用户操作网页。这种混淆会把“代码写权限”错误扩大为“桌面和账号权限”。

**外部实践对比：** Claude Code 的官方 Chrome 能力依赖单独的 Chrome 集成/扩展来连接浏览器，并不是普通 CLI 子进程天然拥有的权限。Deer Workflow 的公开 Runtime 文档未提供 Browser/Chrome/Playwright/screenshot 的 Workflow API；它将可用工具能力留给底层 Agent Runtime。

**设计决定：** 当前 `CodexCliAdapter` 明确定位为无浏览器的独立代码 Agent 节点。浏览器能力必须作为后续独立的执行环境建设：

```text
Browser Host
  -> 显式管理浏览器实例、扩展连接、截图与用户授权
  -> 产生截图/页面证据 Artifact

Browser-capable Adapter 或显式 ctx API
  -> 只在 Workflow 明确请求时连接 Browser Host
```

**不应采用的捷径：** 不应让普通 `ctx.agent()` 隐式继承用户当前浏览器；不应把 Browser Use 当作 `codex exec` 的 shell 参数；不应因 `workspace-write` 自动授予浏览器控制。

**可行后续方案：** 优先评估可独立运行、可隔离的浏览器宿主（例如 Playwright 管理的专用浏览器上下文，或受控 Chrome 扩展 Host），再通过显式 capability/adapter 连接 Workflow。页面访问、截图、表单提交和登录态必须分别定义授权与 Artifact 记录规则。

**刁钻考官追问：** “为什么不直接复用用户正在看的浏览器？”

**短答：** 复用能提升便利性，但会把独立、可复现的 Workflow 节点与用户个人登录态、当前 Tab、浏览历史和桌面授权耦合。首版优先节点隔离；若以后支持复用，必须要求显式用户选择目标 Tab、明确授权范围，并记录访问与截图证据。

### 3.8 为什么结构化输出需要 Codex 约束和 Runtime 二次校验

**设计决定：** `ctx.agent({ schema })` 同时使用 Codex `--output-schema` 与本地 Ajv 校验，而不是只要求 Prompt “返回 JSON”。

**原因：** 下游 Workflow 要根据结果做分支、循环或人工确认时，自然语言不是稳定接口；而只依赖外部 CLI 的结构化承诺又会让 Runtime 在 CLI 版本变化、异常退出或格式漂移时失去边界。Codex 负责在 Agent Loop 内尽量修正输出，Ajv 负责在结果跨越 Runtime 边界前验证实际值。

**临时文件取舍：** Codex `--output-schema` 接受文件路径，而不是 JSON 字符串，因此 Adapter 必须创建短生命周期 schema 文件。该文件放系统临时目录，不是项目文件、不是 Artifact；无论节点成功还是失败都要清理。

**最脆弱假设：** JSON Schema 由 Workflow 作者手写，TypeScript 泛型和 Schema 可能不一致。首版不自动生成类型，必须通过测试和清晰示例降低漂移；未来可考虑 schema-first 类型推导，但不能假装当前已经保证静态一致。

**刁钻考官追问：** “为什么有 `--output-schema` 还要引入 Ajv？”

**短答：** `--output-schema` 是外部 Agent 的生成约束，Ajv 是本 Runtime 的输入验证。边界系统不应将外部进程的成功退出等同于数据契约成立。

**真实集成证据：** 已使用真实 `CodexCliAdapter` 与最小 schema `{ ok: boolean }` 运行只读探针，Codex 经临时 `--output-schema` 文件返回 `{"ok":true}`；Runtime 可将该文本解析为 JSON 并通过 Ajv 校验。单元测试另覆盖非法 JSON、必填字段/类型/额外字段错误，以及校验失败时 `agent.failed` 在 `workflow.error` 前发生。

### 3.9 为什么验证结果要区分代码失败与环境阻塞

**问题来源：** `readiness-check` 在只读 Codex 节点中尝试运行 `bun test`，测试里的 `mkdtemp()` 被 sandbox 拒绝并返回 EPERM；而用户在正常本机终端运行同一命令得到 22 pass / 0 fail。若只返回 `canProceed: false`，Workflow 会把“验证环境不可用”错误理解为“代码或测试失败”。

**设计决定：** Readiness Schema 增加 `verification.status`：`passed`、`failed`、`not_run`、`blocked_by_environment`，并要求 Agent 报告 `reason`。

**语义边界：** `failed` 仅表示验证实际运行且失败；`blocked_by_environment` 只表示 Agent 不能在当前 sandbox/权限/依赖条件下完成验证。两者必须由后续 Workflow 采取不同分支，不能混为一个布尔结果。

**刁钻考官追问：** “为什么不直接给验证 Agent workspace-write？”

**短答：** 能跑测试不等于应扩大所有 Agent 的写权限。当前 Codex Adapter 保持 read-only；未来应建立显式、受审查的验证执行环境或专用 sandbox 策略，而不是让普通分析节点因为临时目录需求获得项目写入能力。

### 3.10 Journaled Replay 为什么先只恢复同一 runId

**设计决定：** `wave-flow run` 每次创建独立 `runId`、manifest 和 journal；只有 `wave-flow resume <run-id>` 可以回放该 run 内已完成 Agent 节点。不同 run 默认绝不互相读取或复用结果。

**原因：** run 是一次独立执行证据，包含当时的 input、工作目录、adapter、脚本版本和副作用上下文。跨 run 的内容缓存会模糊“这次运行实际做了什么”，也可能把旧环境或旧输入的结果误当作新任务证据。

**恢复模型：** 不是保存 JavaScript 调用栈，而是重新执行 Workflow，并在每个 `ctx.agent()` 处查询同一 run 的 Journal。只有先落盘的 `agent.completed` 可返回 `replayed: true`；started、failed 和中断节点一律重新执行。

**节点身份：** 首切片用 `label + 调用顺序` 区分同一 run 内的 Agent 调用，同时比较 prompt、schema、cwd 与 adapter 的 hash。脚本 hash 不同则拒绝 resume，不做猜测性恢复。

**与 Claude 的关系：** Claude Code 的动态工作流在暂停后按代理启动顺序重放：已完成代理返回保存结果，停止中/失败代理重跑。wave-flow 借鉴该“完成结果可重放、未完成结果不可信”的边界，但采用本地 `manifest.json + journal.jsonl` 作为独立 CLI Runtime 的证据。

**刁钻考官追问：** “为什么不直接做跨 run 缓存，省更多 Token？”

**短答：** 优化成本不能改变 run 隔离和审计语义。跨 run 缓存是可选的显式产品能力，必须定义环境、输入、脚本和副作用的失效规则；不能在首版恢复功能中默认启用。

**真实 CLI 证据：** 使用 `parallel-review` 创建新 run 后，Journal 记录两个 completed 节点；`wave-flow inspect <run-id>` 显示 `completed=2`，随后 `wave-flow resume <run-id>` 对两个节点均发出 `agent.replayed`，结果的 `replayed` 为 `true`，没有再次启动 Fake Adapter。

### 3.11 Journaled Replay 首次安全审查修复

**问题来源：** 真实 `security-review` 节点审查 Journal 实现后发现三个边界缺口：runId 路径穿越、未校验 manifest 导致 resume 可能导入任意本地 TypeScript，以及 Codex stdout 单条无换行 JSONL 可无界占用内存。

**修复 1：runId 与目录边界。** `resume/inspect` 只接受 Runtime 生成的 UUID。路径在 `resolve()` 后必须仍位于 `.wave-flow/runs` 根目录内，拒绝 `../`、非 UUID 或目录逃逸。

**修复 2：manifest 先验证、项目边界后 import。** Journal 打开时严格检查 manifest：请求 runId 一致、Workflow/cwd 为绝对路径、hash 为 SHA-256、adapter 属于支持枚举、input 为对象、时间格式有效。恢复时 Workflow/cwd 必须仍位于当前项目根目录内，且源码 hash 匹配后才动态 import；因此被篡改的 manifest 不能让 `resume <run-id>` 访问项目外任意模块或目录。Journal 状态仍属于当前本地项目的受信任状态；若同一用户可任意篡改项目内文件，CLI 无法在没有外部密钥/签名机制时证明其完整性。

**修复 3：JSONL 单行上限。** Codex stdout 继续流式 drain；当未换行缓冲超过 1 MiB 时记录解析错误、丢弃该缓冲而继续读取到 EOF。这样不会因坏 CLI 或恶意 executable 的无换行输出撑满内存，同时仍等待子进程退出并保留有限 stderr 诊断。

**补充边界：** Journal 中已保存的结构化 output 在 replay 时仍通过当前调用的 JSON Schema 校验，不能因“曾经落盘”绕过 Runtime 数据契约。

**刁钻考官追问：** “Journal 是本地文件，为什么还要防篡改？”

**短答：** 本地状态不等于可信输入。`resume <runId>` 的用户没有重新显式选择 workflowPath；因此 manifest 若被篡改就可能把恢复命令变成任意本地模块导入。最小 schema/path/hash 验证保护的是恢复入口的能力边界，不是在宣称本地文件不可被修改。

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

### Q7：为什么不直接使用 BotMux 或 tmux 运行 Codex？

**短答：** BotMux/tmux 擅长长驻会话和人工接管；wave-flow 当前需要的是一次性、独立、可测试的 Workflow 节点。`codex exec --json` 已提供适合非交互节点的结构化 stdout、工作目录与 sandbox 参数，直接使用可避免引入 daemon、PTY 和会话回收复杂度。

**局限：** 若未来需求变为“用户在 Agent 运行中 attach、追问或接管同一上下文”，应设计独立的 Session Adapter 或对接 BotMux，而不是污染基础 AgentAdapter 的节点语义。

### Q8：为什么不只让 Prompt 要求返回 JSON？

**短答：** Prompt 只能提升概率，不能构成运行时类型契约。只要下游要分支或自动执行，Runtime 必须对实际 JSON 和 Schema 做验证；否则一个字段缺失或类型漂移就会在后续节点扩大成错误决策。

**局限：** Schema 验证能保证形状，不能保证语义正确。例如 `canProceed: true` 的业务判断仍可能错误，需要后续 verifier、assert 或人工确认机制。

## 5. 当前状态快照

### 已验证

- Workflow `meta` 与入口校验。
- `ctx.agent()` 的统一 Adapter 委派、结果包装和生命周期事件。
- `ctx.parallel()` 的并行启动、顺序保持、失败隔离与屏障等待。
- Fake Adapter 下的 `wave-flow run`、`--input`、`--input-file`、`--cwd`、终端事件输出。
- Bun 类型检查和自动化测试。

### 未实现或未验证

- 真实 Codex CLI Adapter 与 `codex exec --json` 事件解析。
- JSON Schema 结构化输出、Ajv 二次校验和 schema 临时文件生命周期。
- `pipeline()`、`phase()`、Scheduler、并发上限、超时、重试和预算。
- JSONL `--print`、Artifact、Journaled Replay、`resume`、`inspect`。
- 写入安全、Worktree 隔离、`create` / `go`、`use` 默认 Adapter 配置。
- 浏览器执行环境：专用 Browser Host、显式能力声明、截图 Artifact 与浏览器授权模型。
