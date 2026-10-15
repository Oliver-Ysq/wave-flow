---
name: workflow-creator
description: 把用户的任务描述变成可运行的 Wave Flow Workflow 脚本，或修改既有 Workflow。当用户要求把可重复的多步骤任务编排为 Workflow、生成或修改含 agent/phase/parallel/pipeline/decisionGate 的脚本、作为主控起草 workflow revision 草案，或修复不符合加载/受限校验的 Workflow 时使用。
---

# Wave Flow Workflow 作者

把用户的任务翻译成一份完整、可被当前 Runtime 真实加载的 Workflow 脚本。
脚本只负责编排；不臆造尚未实现的 API，也不假设运行时会向全局注入任何函数。

## 先确认作者形态

Wave Flow 有两种模块形状，规则不同，写代码前必须确认目标：

1. **受信任本地模块**：用户通过 CLI `wave-flow run <workflow.ts>` 运行的项目内 `.ts` 文件。
   是 ESM 模块：`import` 作者 API → `export const meta` → `export default async function run(args)`。
2. **主控受限草案**：主控（Harness）经 `propose_workflow_revision` 提交、用户审批后由受限 Runtime 执行的脚本。
   **不是模块**：禁止一切 `import`/`export`；顶层只有 `const meta = { … }`、`async function run(args)` 和类型声明；作者 API 由运行时注入。

判断依据：在主控会话中起草、或交付物将由用户审批后执行时，一律写受限草案；用户明确要求一个本地 `.ts` 文件时用受信任模块。两种形状的完整契约见 [references/api.md](references/api.md)。

不要从零写骨架：以 [assets/workflow.restricted.txt](assets/workflow.restricted.txt)（受限草案，纯文本模板）或 [assets/workflow.ts](assets/workflow.ts)（受信任模块）为起点，替换其中的阶段、prompt 与输入输出。这两份模板持续通过当前真实校验门禁，是唯一可信的形状参照。

## 建立目标

从需求与项目上下文推断：kebab-case 的 Workflow 名称、一行 description、`args` 输入对象、
`run()` 返回给调用方的最终值、有序的 Phase 划分，以及哪些步骤是确定性协调（映射、过滤、
计数、去重、阈值检查）、哪些步骤需要 Agent 的判断或工具。只有当缺失的答案会实质改变
Workflow 是否读取或修改用户数据时才提问；否则做最小合理假设。

## meta 契约

`meta` 必须是纯字面量（无变量、调用、展开、计算属性或模板字符串）：

- `name`：kebab-case，如 `deep-research`。
- `description`：非空单行说明，面向 CLI 与 Web 展示。
- `phases`：非空有序的 `{ title: "…" }` 数组，title 唯一；每次 `phase(title)` 必须精确匹配其一。
- `exampleArgs`：可选的最小可运行 JSON 输入，键必须对应 `run(args)` 实际读取的字段。

## 设计编排

可重复的机制留在 TypeScript 里，语义判断交给 `agent()`。选择能表达依赖关系的最小原语：

- 下一步依赖上一步完整结果：普通 `await` 顺序调用。
- 多个互相独立的任务：`parallel()`，每项是零参数惰性函数，共享同一个汇合点。
- 每个 item 独立经过同一组阶段：`pipeline()`。
- 需要看到全部结果的操作（全局排序、去重、终审）：放在两次并发之间的普通代码里。

`phase()` 在进入并发前设置一次；绝不在 `parallel()` 任务或 `pipeline()` 阶段内调用，
并发分支共享同一个 Workflow 执行上下文。

并发与多 Agent 的设计细节（计划→扇出→汇总、逐 item 流水线、独立验证、代码改动任务的
写冲突约束等）见 [references/patterns.md](references/patterns.md)。

## 定义 Agent 边界

把 `agent()` 当作一次完整的、带工具的编码 Agent 会话（当前已验证的 CLI 是 `codex`
与 `kimi`），而不是一次文本补全：

- 每个 prompt 必须自包含：任务、范围、相关上游结果、约束与期望产出。Agent 不会自动
  继承另一个 Agent 的对话内容。
- `id` 必填，Run 内唯一且稳定（1–120 位字母数字与 `. _ : / -`）；它参与会话绑定与
  replay 指纹，不要在两次运行间随意改名。
- 下游代码要解析结果时提供 `schema`（JSON-safe 对象），并配套 TypeScript 类型。
- `sandbox` 只允许 `read-only`（默认）或 `workspace-write`；没有更高权限模式。
- 直接 `await agent()` 的失败会抛出并把节点标记为 interrupted；`parallel()` 内失败的
  任务结果为 `null`，使用前必须过滤或判空。
- **不要**在 prompt 里指导 Worker 如何上报完成。Runtime 会为每个 Worker session
  注入私有 `wave_flow_complete / block / continue` MCP 工具；作者只描述业务任务。
  Worker 需要人工输入时会自行 `block`，无需作者编排。

## 人工决策

- 脚本级的业务决策（仅在受限草案可用）：`decisionGate(id, question, answerSchema?)`，
  阻塞等待用户在界面上提交经 Schema 校验的 JSON 答案。只用于没有人类决定就无法安全
  继续的真正分叉；普通错误由脚本自行处理。
- 决策不是节点状态机的一部分；gate 的 id 在同一 Run 内唯一。

## 保持可观测

长任务以 `log()` 作为实时状态通道：进入阶段时说明范围；每个可能较慢的 `agent()` 之前
说明它在做什么；扇出时报告各任务开始与完成；汇总前说明有多少可用结果。日志只发
新信息，不发心跳式空消息，绝不记录密钥、完整 prompt 或大段 Agent 原文。

## 受限草案的额外硬约束

主控 `propose_workflow_revision` 同时提交 `source`、本轮 `goal` 与工作边界 `scope`。
这是 Wave Flow 主控控制面，不是 Workflow 作者 API。同一未执行候选的修改追加同卡版本，
接受不执行，旧批准不能启动新版本。首份执行后多轮暂未开放，不提案下一份流程。

除"不是模块"外，受限脚本还遵守：

- 草案在**提案时**就必须通过完整受限编译门禁（语法、顶层形状、meta）；不可编译的源码不会被冻结，错误诊断会带行列位置返回给你，修正后重新提交即可。
- 字符串与标点只使用 ASCII：中文引号（`“”‘’`）、全角分号、省略号等任何非 ASCII 标点都会在编译前被拒绝。脚本正文（含 prompt 里的中文内容）必须用 ASCII 引号包裹。

- 可引用的全局只有 `agent`、`phase`、`parallel`、`pipeline`、`log`、`decisionGate`、`JSON`、`Error`
  与脚本内声明的标识符；`process`、`Bun`、`fetch`、`Math`、`Date`、`Object`、`globalThis` 等
  一律在编译前被拒绝。
- 禁止 class、`this`/`super`、generator、标签语句、动态 `import()`、`constructor`/`prototype`/`__proto__` 成员访问。
- 资源护栏：`agent()` 调用总数 ≤ 20，`phase()` 切换 ≤ 50，`decisionGate()` ≤ 10。

## 交付前校验

1. 形态正确：受信任模块有 `import`/`export`；受限草案没有任何 `import`/`export`。
2. `meta` 是纯字面量，含 kebab-case `name`、单行 `description`、唯一非空 `phases`。
3. 每个 `phase()` 调用精确匹配某个 `meta.phases[].title`；`phase()` 不在并发分支内。
4. 每个 `agent()` 都有唯一稳定 `id` 且 `cli` 为 `"codex"` 或 `"kimi"`；`sandbox` 只取 `read-only`/`workspace-write`。
5. `parallel()` 每项都是零参数函数；并发结果在使用前判空。
6. 需要解析的 Agent 结果同时有 `schema` 和对应类型。
7. 脚本级人工决策使用 `decisionGate`（仅受限草案）；prompt 不含完成上报指令。
8. 每个可能较慢的操作之前都有 `log()`。
9. 引用的每个 API 都存在于 [references/api.md](references/api.md)；不臆造 `workflow()` 嵌套、
   `danger-full-access`、重试或预算字段。
