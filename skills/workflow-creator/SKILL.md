---
name: workflow-creator
description: 把用户的任务描述变成可运行的 Wave Flow Workflow 模块，或修改既有 Workflow。当用户要求把可重复的多步骤任务编排为 Workflow、生成或修改含 agent/phase/parallel/pipeline/decisionGate 的模块、作为主控起草 workflow revision 草案，或修复不符合加载/模块校验的 Workflow 时使用。
---

# Wave Flow Workflow 作者

把用户的任务翻译成一份完整、可被当前 Runtime 真实加载的 Workflow 脚本。
脚本只负责编排；不臆造尚未实现的 API，也不假设运行时会向全局注入任何函数。

## 统一模块形态

Wave Flow 只有一种 Workflow 形状：ESM 作者模块。

```ts
import { agent, decisionGate, log, parallel, phase, pipeline } from "wave-flow";

export const meta = { /* 纯字面量 */ };

export default async function run(args) { /* 编排 */ }
```

两种入口共用同一格式与校验：

1. **主控生成**：主控（Harness）经 `propose_workflow_revision` 提交；用户审批后执行，或显式保存并接管为项目内本地来源。
2. **本地文件**：用户选择项目内 `.ts` 文件，预检后通过桌面任务入口确认运行。

不要从零写骨架：以 [assets/workflow.ts](assets/workflow.ts) 为起点，替换阶段、prompt 与输入输出。完整契约见 [references/api.md](references/api.md)。

## 建立目标

从需求与项目上下文推断：kebab-case 的 Workflow 名称、一行 description、`args` 输入对象、
`run()` 返回给调用方的最终值、有序的 Phase 划分，以及哪些步骤是确定性协调（映射、过滤、
计数、去重、阈值检查）、哪些步骤需要 Agent 的判断或工具。只有当缺失的答案会实质改变
Workflow 是否读取或修改用户数据时才提问；否则做最小合理假设。

## meta 契约

meta.description 用简短任务名称式说明（建议20个中文字符以内），用于聊天方案标题；不要把完整目标、范围和风险塞进description。详细内容放在提案goal/scope，短标题不替代这些边界。

`meta.inputSchema` 是当前 Workflow 的输入契约：必须声明纯字面量、JSON-safe 对象 Schema（`type: "object"`）；无参数用 `{type:"object",properties:{},additionalProperties:false}`。主控生成与本地新 Task 都强制要求；它不等于节点结果 schema，不以 exampleArgs 猜默认或必填。旧记录缺省只读，不再作为新草案形状。

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
写冲突约束等）见 [references/patterns.md](references/patterns.md)。内置目录的 `deep-research`
与 `deep-cr` 展示了长任务编排的完整骨架（计划确认、分维度并行、逐条独立核验、缺口补证、
红队审查、覆盖披露）；起草同类 Workflow 时按同一骨架组织，不要退化成"并行几个节点再汇总"。

## 托管技能库

执行期会把 `~/.wave-flow/skills/<name>/SKILL.md` 的托管技能投影注入主控与每个 Worker 会话（空库不改变行为）。用户点名技能时，默认理解为 Worker 节点的执行依赖，不是让主控立即代做；除非用户明确要求主控执行。主控仍可按自己的判断自由使用 skill 做设计、读取或准备。把技能写进相应 Worker 节点的 prompt，例如“建议使用托管技能 X，先加载并按 SKILL.md 执行”；仅作为任务提示，不做额外校验或阻塞，不要假设未在库中的 skill 一定可用。库非空但当前 CLI 没有已验证注入能力、或库内 skill 非法时，会话启动前会 fail closed。Kimi CLI 支持已暂时下线，不得在 `cli`、提示词或计划中把它当作可用执行底座。

## 定义 Agent 边界

Wave Flow 新增宿主边界：主控默认感知模式使用原生CLI配置与工具（skill/MCP/CLI可用），Seatbelt只拒绝写当前项目与Engine状态目录；设置关闭后回到私有Home与全量写隔离，四个窄MCP不变。Worker使用可信原生CLI/Home/权限，不做额外OS文件隔离。read-only/workspace-write表示任务意图，不保证不可越界。一次Execution只创建一个受管worktree，所有写节点共享同一cwd；不再有工作区分组、集成来源或集成节点。并行写直接写同一目录，宿主不做冲突检测或自动合并，后写会覆盖先写，因此必须按模块/文件分区；同一文件或逻辑区域的写入要顺序执行，依赖前序结果的写入放到后续phase。执行完成后宿主不保存任何成果快照、不创建commit、HEAD与真实index不变；结果只保留在该worktree的当前未提交文件里，不写入主工作区；主分支不移动、不push。用户自行查看、修改、提交或清理，清理会删除未提交内容。作者不新增worktree/commit/merge接口，不让Worker自行提交；cwd/prompt/lease不能阻止可信Worker写其他目录，外部影响不由Git证明。

把 `agent()` 当作一次完整的、带工具的编码 Agent 会话（`cli` 当前允许 `codex` / `claude` / `dsh`；
三者均已完成真实验收，均可设为主控；claude 的主控验收验证 harness 兼容性，模型侧由用户认证配置决定），而不是一次文本补全：

- 每个 prompt 必须自包含：任务、范围、相关上游结果、约束与期望产出。Agent 不会自动
  继承另一个 Agent 的对话内容。
- 产出是给人读的文本时，prompt 必须写清读者、文体与禁忌：例如“写给没进过这个仓库的同事”、
  “不要罗列内部包名”“不用‘以……为准’这类公文腔”。只写“返回三行摘要”会让模型交出内部代号清单；
  `schema` 只校验形状，不校验内容是否可读，Schema 通过不等于结果合格。
- 让 Worker 先读 `AGENTS.md` 只为避免误操作时，要明确“仓库内部约定、包名、代号不要写进产出”，
  否则这些内部词会顺着上下文进入给用户的结果。
- `id` 必填，Run 内唯一且稳定（1–120 位字母数字与 `. _ : / -`）；它参与会话绑定与
  replay 指纹，不要在两次运行间随意改名。循环里只能按轮次生成 id：写节点（`workspace-write`）
  的动态 id 必须以非空字面量开头（如 `"repair-" + round` 或 `` `repair-${round}` ``），
  宿主按该前缀向用户披露并核验实际写节点；`sandbox` 必须是字面量，`id` 只能是字面量或上述
  前缀形式。不要用展开、变量或 `id`/`sandbox` 简写，否则写意图不可核验，草案会被拒绝。
- 下游代码要解析结果时提供 `schema`（JSON-safe 对象），并配套 TypeScript 类型。
  这个 `schema` 会同时成为完成工具的入参签名：模型每轮都能看到"必须交什么形状的结果"，
  不依赖它在提示词里记住一句"结果要符合某 Schema"。因此 `schema` 要能直接表达为工具入参
  （根为 object），否则完成上报会被 Control 的复验拒绝。
- `sandbox` 只允许 `read-only`（默认）或 `workspace-write`；没有更高权限模式。
- 直接 `await agent()` 的失败会抛出并把节点标记为 interrupted；`parallel()` 内失败的
  任务结果为 `null`，使用前必须过滤或判空。
- Wave Flow 宿主成果交接契约错误不属于普通任务失败：运行期 writer 真实退出无法核验或租约交接失败时，原节点保持 completed、Execution 收敛为 interrupted；`parallel()`/`pipeline()` 必须抛出该契约错误，不能用 null 跳过。原版 resume 先补交接，不重跑已完成业务。Execution 完成后宿主不保存成果快照、不创建 commit；结果就是受管 worktree 当前的未提交文件，后续由用户自行查看、修改、提交或清理。Workspace 配置与提交授权由 Engine/用户管理，作者不新增 worktree、commit、合并字段，不让模型预测 commit/tree hash。Codex/DeepSeek Harness/Claude 的受管并行写已有真实证据；只有Engine冻结授权与已验证Adapter同时满足才可执行。
- 并行写共享同一 worktree，没有宿主冲突检测或合并：任务分配必须让不同 Agent 写不同模块/文件，每个文件只有一个 owner；同一模块的改动必须顺序执行，或把依赖前序结果的修改放到后续 phase。不要把“两个 Agent 同时改同一文件/同一函数/同一配置块”当作可接受设计，也不要在脚本里安排集成 Agent 去解冲突。执行完成后宿主不保存快照，结果只保留在受管 worktree 的当前未提交文件里，不写入主工作区；冲突已被覆盖时不会报错或恢复丢失的修改。
- **不要**在 prompt 里指导 Worker 如何上报完成。Runtime 会为每个 Worker session
  注入私有 `wave_flow_complete / block / continue` MCP 工具；作者只描述业务任务。
  Worker 需要人工输入时会自行 `block`，无需作者编排。

Runtime在原Worker回合结束但未完成时，最多补发一次由Control当前事实生成的收尾回合：只上报已有结果，或沿用原人工请求取得答案后由Worker判断continue。它不重做业务、不自动新建attempt；作者不新增重试/收尾API，也不把回合结束当作交付。上下文被压缩后，下一个回合边界会把原始任务描述作为**只读背景**附回（明确不重新授权执行），恢复任务语境；模型已丢失的业务判断与已发生的外部副作用宿主无法恢复，只能由用户显式resume重跑。

Wave Flow 新增恢复边界：原生ACP会话超过宿主窗口无实质进展（正文/工具/计划事件）时只记录一条耐久停滞提示，不自动中断、不cancel、不杀进程、不重发任务或创建attempt，唯一出口是用户显式停止；block、暂停及在途Control落盘属于合法等待。原冻结版本resume先满足原终态总结和当前Git现场补充，再核验授权、writer退出与已保存现场；现场漂移拒绝并提示修订，不回滚。业务已completed的恢复只读返回原终态，不补成果快照、不重做Worker，也不自动应用。当前现场补充是独立证据版本，不改写旧总结，不构成新执行批准，也不证明ignored文件或外部系统无变化。作者不新增stall/retry或跨Execution缓存接口。

## 人工决策

- 脚本级的业务决策：`decisionGate(id, question, answerSchema?)`，阻塞等待用户在界面上
  提交经 Schema 校验的 JSON 答案。只用于没有人类决定就无法安全继续的真正分叉；
  普通错误由脚本自行处理。
- 决策不是节点状态机的一部分；gate 的 id 在同一 Run 内唯一。

## 保持可观测

长任务以 `log()` 作为实时状态通道：进入阶段时说明范围；每个可能较慢的 `agent()` 之前
说明它在做什么；扇出时报告各任务开始与完成；汇总前说明有多少可用结果。日志只发
新信息，不发心跳式空消息，绝不记录密钥、完整 prompt 或大段 Agent 原文。

## 主控生成与保存接管约束

先读取 read_run_capsule 中 Task 的 workflowContract。若为 single-workflow-v1，同一 Task 只维护当前 Workflow 链：已有执行后，反馈只能修订同链，目标无关时请用户新建 Task。主控只能准备草案，不能批准或自动启动；用户确认和当前现场证据仍由Engine核验。本地来源只由用户编辑并重新预检，不提交生成源码替换；只有首次执行前明确放弃当前候选，才允许重选来源。用户可以把当前生成模块“保存并接管”为项目内本地来源；接管后主控不能再替换源码，后续修改必须由用户编辑文件并重新预检。旧 Task 缺省保留历史多卡规则，不凭名字或路径迁移。

### 影响面总结与证据读取（Wave Flow 新增设计）

`read_run_capsule` 返回 `{text,truncated,redacted}` 有界数据；`text` 是脱敏JSON片段，截断时不可假装完整JSON。指定原尝试须同时提供 `executionId` 和正整数 `attempt`，Engine核验同Task归属；总结回合省略参数时默认其原义务attempt。普通Task快照与历史结果不是新指令，不拼接全部历史执行。自动总结回合来源是summary key，不是用户消息。

每次目标态Execution终态须完整总结后才可启动或resume；总结失败只能重试总结，不重跑Worker、不跳过门禁。总结说明原状态、已验证交付、缺口与下一步；Schema通过不是验收。受管写以Capsule真实Git基准、租约、worktree保留状态与当前现场指纹说明影响；宿主不保存成果快照，缺失或不可读不能当完整基线。共享worktree不提供逐节点文件归因，不能宣称某个Agent的修改可独立回滚。工作区外写没有Wave Flow OS拦截；网络/外部副作用不能由Git推断。只能提出草案，不能批准或派发。

主控 `propose_workflow_revision` 同时提交 `source`、本轮 `goal` 与工作边界 `scope`。goal/scope 要说明主控与 Worker 的分工：用户点名的技能默认由 Worker 执行，主控仍可自由使用 skill 做设计、读取或准备。
源码修订必须先读取当前Capsule，提供顶层`baseRevision`等于当前最新版本；首次没有版本时允许0或省略。已有单链版本缺失或过期依据会拒绝，不能用迟到提案覆盖用户修改。参数模式仍使用`parameters.baseRevision`，两处同时提供时必须一致。该宿主版本护栏不新增Workflow作者API或执行权。
宿主续作自动接续同Task最近写Execution的唯一共享worktree，使用独立新授权并冻结交接HEAD，不覆盖旧授权或复制completed节点。作者不能提供continuation/workspace/commit字段。新版修改Prompt应先检查已有改动，再修正与验证，不返回历史JSON代替重新工作。共享worktree中的旧改动会保留；并行写仍须按模块/文件分区，不假设宿主会合并或恢复被覆盖的修改。CLI-only修订由用户准备配置新版本，主控不选择/批准/派发。
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

模块硬约束：

- 草案在**提案时**就必须通过完整静态门禁（语法、顶层形状、meta 与 inputSchema）；不可编译的源码不会被冻结，错误诊断会带行列位置返回给你，修正后重新提交即可。
- 值导入只允许来自 `"wave-flow"`；类型导入不受限；禁止动态 `import()`。`import` 必须位于 `meta` 之前。
- 顶层只允许 import、`export const meta`、类型声明与 `export default async function run(args)`；不得执行其他顶层语句。
- 字符串与标点使用合法 TypeScript/ASCII 引号；中文引号（`“”‘’`）、全角分号、省略号等会导致语法错误。
- 主控生成稿会被用户审批后执行，或在用户显式“保存并接管”后成为项目内本地模块；它与手写 Workflow 同等受信任，可访问本机。不要用它读取、传输或修改用户未明确授权的数据。
- `decisionGate` 是正式作者 API，本地与生成模块都可使用；它只做编排层人工决策，不替代 Worker 的 block/continue。
- 资源护栏：主控生成的 Execution 受宿主 `agent()` 总数 ≤ 20、`phase()` 切换 ≤ 50、`decisionGate()` ≤ 10 约束；不要依赖无限循环或动态扩权。

## 交付前校验

1. 形态正确：ESM 模块包含 `import`、`export const meta` 与 `export default async function run(args)`；没有任何受限方言或无 import 的脚本形态。
2. `meta` 是纯字面量，含 kebab-case `name`、单行 `description`、唯一非空 `phases`。
3. 每个 `phase()` 调用精确匹配某个 `meta.phases[].title`；`phase()` 不在并发分支内。
4. 每个 `agent()` 都有唯一稳定 `id`。`cli` 可以省略：省略时由用户在启动前**逐节点**为该节点选择一个本机已验证的 CLI（同一份模块的不同节点可以跑在不同 CLI 上，粒度与主控生成稿逐节点声明一致）；写死时只接受 `"codex"` / `"claude"` / `"dsh"`（三者均已完成真实双角色验收，均可设为主控），且不会被节点选择覆盖。可移植模块与内置预置应当省略 `cli`，让同一份源码能在只装了某一个 CLI 的机器上运行；循环/变量 id 的动态调用无法逐节点列出，需要一个兜底选择。`"kimi"` 支持已暂时下线，不得写入新草案。`sandbox` 只取 `read-only`/`workspace-write`，且必须是字面量；循环写节点按轮次生成 id 时必须以非空字面量前缀开头，供宿主披露与核验。
5. `parallel()` 每项都是零参数函数；并发结果在使用前判空。
6. 需要解析的 Agent 结果同时有 `schema` 和对应类型。
7. 脚本级人工决策使用 `decisionGate`；prompt 不含完成上报指令。
8. 每个可能较慢的操作之前都有 `log()`。
9. 引用的每个 API 都存在于 [references/api.md](references/api.md)；不臆造 `workflow()` 嵌套、
   `danger-full-access`、重试或预算字段。
