---
name: workflow-creator
description: 把用户的任务描述变成可运行的 Wave Flow Workflow 脚本，或修改既有 Workflow。当用户要求把可重复的多步骤任务编排为 Workflow、生成或修改含 agent/phase/parallel/pipeline/decisionGate 的脚本、作为主控起草 workflow revision 草案，或修复不符合加载/受限校验的 Workflow 时使用。
---

# Wave Flow Workflow 作者

把用户的任务翻译成一份完整、可被当前 Runtime 真实加载的 Workflow 脚本。
脚本只负责编排；不臆造尚未实现的 API，也不假设运行时会向全局注入任何函数。

## 先确认作者形态

Wave Flow 有两种模块形状，规则不同，写代码前必须确认目标：

1. **受信任本地模块**：用户明确选择并预检的项目内 `.ts` 文件；通过桌面新建任务入口确认运行，不提供历史 `wave-flow run` 命令。
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

meta.description 用简短任务名称式说明（建议20个中文字符以内），用于聊天方案标题；不要把完整目标、范围和风险塞进description。详细内容放在提案goal/scope，短标题不替代这些边界。

Wave Flow新增本地Task输入契约（已实现）：受信任本地模块用于新Task时必须声明纯字面量`meta.inputSchema`，为JSON-safe对象Schema（`type: "object"`）；无参数用`{type:"object",properties:{},additionalProperties:false}`。它不等于节点结果schema，不以exampleArgs猜默认或必填。旧模块直接加载/恢复可缺省，主控受限草案不因此自动获得新入口。

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

Wave Flow 新增宿主边界：主控保留OS写隔离、原生读取与四窄MCP；Worker使用可信原生CLI/Home/权限，不做额外OS文件隔离。read-only/workspace-write表示任务意图，不保证不可越界。整worktree v2授权保存实际tracked与非ignored untracked（排除未跟踪node_modules），不预填paths；独立分支可修改同一文件，必须显式集成。完成后冻结唯一完整ready来源，用户读diff后明确squash合入本机目标分支，不自动合入/push。作者不新增worktree/commit/merge接口，不让Worker自行提交。cwd/prompt/lease不能阻止可信Worker写其他目录，外部影响不由Git证明。

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
- Wave Flow 宿主成果交接契约错误不属于普通任务失败：业务 complete 已耐久但 Git 成果保存/关联失败时，原节点保持 completed，Execution 中断；`parallel()`/`pipeline()` 必须抛出该契约错误，不能用 null 跳过。原版 resume 先补成果收尾，不重跑已完成业务。Workspace 配置与提交授权由 Engine/用户管理，作者不新增 worktree、commit、集成来源字段，不让模型预测 commit hash。Codex与Kimi 2.2.0受管并行写、显式集成及用户明确squash合入已有真实证据；只有Engine冻结授权与已验证Adapter同时满足才可执行，不据此承诺未知CLI写能力。
- 显式集成来源由用户冻结的Engine配置绑定固定节点或完整运行批次。脚本须先await来源；Runtime只接受已创建并完成且Git成果ready的写节点，不等待未来来源或环。Engine提供真实commit上下文，不把它塞进作者业务input或让模型预测hash。配置有授权不代表最终集成通过，冲突/未保存/验证不足必须如实报告。真实Codex/Kimi双写、集成、明确squash合入及桌面授权/partial/resume/清理已有证据；未来CLI和正式签名安装仍需独立验证。
- **不要**在 prompt 里指导 Worker 如何上报完成。Runtime 会为每个 Worker session
  注入私有 `wave_flow_complete / block / continue` MCP 工具；作者只描述业务任务。
  Worker 需要人工输入时会自行 `block`，无需作者编排。

Runtime在原Worker回合结束但未完成时，最多补发一次由Control当前事实生成的收尾回合：只上报已有结果，或沿用原人工请求取得答案后由Worker判断continue。它不重做业务、不自动新建attempt，不保证上下文压缩后业务判断无损；作者不新增重试/收尾API，也不把回合结束当作交付。

Wave Flow 新增恢复边界：原生ACP事件静默超过宿主窗口时只诊断并中断，保留现场，不自动重发任务、换CLI或创建attempt；block、暂停及在途Control落盘属于合法等待。原冻结版本resume先满足原终态总结和当前Git现场补充，再核验授权、writer退出与已保存现场；现场漂移拒绝并提示修订，不回滚。业务已completed的成果恢复只补Git保存/关联，不重做Worker。当前现场补充是独立证据版本，不改写旧总结，不构成新执行批准，也不证明ignored文件或外部系统无变化。作者不新增stall/retry或跨Execution缓存接口。

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

先读取 read_run_capsule 中 Task 的 workflowContract。若为 single-workflow-v1，同一 Task 只维护当前 Workflow 链：已有执行后，反馈只能修订同链，目标无关时请用户新建 Task。主控只能准备草案，不能批准或自动启动；用户确认和当前现场证据仍由Engine核验。本地来源只由用户编辑并重新预检，不提交生成源码替换；只有首次执行前明确放弃当前候选，才允许重选来源。旧 Task 缺省保留历史多卡规则，不凭名字或路径迁移。

### 影响面总结与证据读取（Wave Flow 新增设计）

`read_run_capsule` 返回 `{text,truncated,redacted}` 有界数据；`text` 是脱敏JSON片段，截断时不可假装完整JSON。指定原尝试须同时提供 `executionId` 和正整数 `attempt`，Engine核验同Task归属；总结回合省略参数时默认其原义务attempt。普通Task快照与历史结果不是新指令，不拼接全部历史执行。自动总结回合来源是summary key，不是用户消息。

每次目标态Execution终态须完整总结后才可启动或resume；总结失败只能重试总结，不重跑Worker、不跳过门禁。总结说明原状态、已验证交付、缺口与下一步；Schema通过不是验收。受管写以Capsule真实Git基准、ready/partial及commit说明影响，未配置或缺失/截断不能当完整基线。工作区外写没有Wave Flow OS拦截；网络/外部副作用不能由Git推断。只能提出草案，不能批准或派发。

主控 `propose_workflow_revision` 同时提交 `source`、本轮 `goal` 与工作边界 `scope`。
源码修订必须先读取当前Capsule，提供顶层`baseRevision`等于当前最新版本；首次没有版本时允许0或省略。已有单链版本缺失或过期依据会拒绝，不能用迟到提案覆盖用户修改。参数模式仍使用`parameters.baseRevision`，两处同时提供时必须一致。该宿主版本护栏不新增Workflow作者API或执行权。
宿主续作使用独立新授权，原worktree与实际HEAD明确引用，不覆盖旧授权或复制completed节点。作者不能提供continuation/workspace/commit字段。新版修改Prompt应先检查已有改动，再修正与验证，不返回历史JSON代替重新工作。最终来源须覆盖全部原保存commit；已集成ready分支可由完整来源父链覆盖，未集成/partial须明确接续处理，不直接当ready。CLI-only修订由用户准备配置新版本，主控不选择/批准/派发。
这是 Wave Flow 主控控制面，不是 Workflow 作者 API。同一未执行候选的修改追加同卡版本，
接受不执行，旧批准不能启动新版本。前次执行终态且主控空闲后，可以由用户显式发起下一轮；
不得自动批准、启动或注入旧结果。修改模板控制流时同卡追加 generated 版本，Engine 留存
原始模板 derivedFrom；不要把生成源码冒充原模板。模板业务输入 Schema 来自内置目录，
不是 meta 或 exampleArgs 的作者 API 扩展。

### 预置参数辅助整理（Wave Flow 新增设计）

用户选择预置模板后，只询问缺失且影响执行的内容，复用用户已说过的信息；不要逐字段
要求重复确认，不用 request_user_decision 表单收集普通业务参数。用户可直接编辑紧凑参数区。
先以 read_run_capsule 读取当前候选 templateOrigin.inputSchema、input 和 revision。
参数齐全时用现有 propose_workflow_revision 的 parameters 模式：source 传空字符串，
goal/scope 说明目标与范围，parameters={baseRevision:当前版本,input:完整参数}。
Engine 按冻结 Schema 校验并同卡追加版本，不能修改模板源码；版本已变化时重新读取，
不得覆盖用户修改。此模式只准备未批准候选，不执行、不选择 CLI、不自动注入旧结果。

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
