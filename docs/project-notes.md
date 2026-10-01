# Wave Flow 项目笔记

> 这里只记录可用于架构说明、技术答辩和后续决策的高价值结论。完整规格见 [设计文档](./wave-flow-design.md)；当前项目结构见 [项目架构图](./project-architecture.md)。

## 项目定位

Wave Flow 是本机单用户的可视化 Dynamic Workflow：Workflow 用 TypeScript 定义控制流，每个 Agent 节点运行一个真实、可交互、长期存活的 Codex 或 Claude Code CLI 会话。Web 以 Phase → Agent 呈现执行状态；二期桌面端复用本地 daemon，而不改变 Runtime 语义。

项目不是“让多个 Agent 同时聊天”的壳，而是将多 Agent 任务拆解为可审阅的编排代码、可控制的真实会话和可恢复的执行证据。

## 已验证事实

### Workflow 语义的参考层级

Claude Code Dynamic Workflows 的官方文档和 Deer Workflow 的公开源码共同证明：动态 Workflow 的核心是代码持有中间结果、分支、循环和并发，`agent()` 承担语义任务，`phase()` 提供进度分组，`parallel()` 与 `pipeline()` 表达两种不同的并发形态。

因此 Wave Flow 不应从零发明与生态割裂的作者 API。`agent(prompt, options)`、`phase(title)`、`parallel([() => ...])`、`pipeline(items, ...stages)` 是优先对齐的基线；任何偏离必须是正常 CLI 会话确有需要的扩展。

### Claude 与 Deer 的恢复差异

Claude 官方已定义同会话恢复：按 Agent 启动顺序重放，已完成且输入链路仍有效的结果可返回；第一个失效 Agent 及之后 Agent 重新运行。Deer 当前公开 Runtime 的重点是单次执行内的 `null` 失败隔离，而非跨进程恢复。

Wave Flow 的 Journaled Replay 选择 Claude 的保守恢复方向，但仅限同一 `runId`，并将 Workflow hash、输入与节点指纹作为复用条件。不能把它描述为 Deer 已有能力。

### Codex 的结构化提问边界

对公开 CLI 行为和 Botmux 的实现调研表明：Codex 没有等价于 Claude `AskUserQuestion` 的通用、可靠结构化 Hook。其普通问题可能只存在于终端自然语言或结束文本中。

结论：把 Codex 屏幕文本正则化为表单是不可靠设计。Wave Flow 必须保留原生终端交互，并以自身受控 `wave-flow block` 满足跨 CLI 的业务型 HITL。

## 关键架构取舍

### 代码编排与真实 CLI 会话分离

Workflow 代码只负责确定性控制流：顺序、扇出、Barrier、过滤、聚合与分支。每次 `agent()` 创建独立节点和独立 CLI 会话；Agent 的原始聊天上下文不被下游隐式继承，下游仅得到上游 `complete` 的最小 JSON 结果。

这样既保留代码的可读性和可测试性，又保留正常 Coding CLI 在长任务、工具调用、权限交互和连续上下文上的能力。代价是 Workflow 作者必须显式传递结果，不能依赖隐式共享记忆；这是为可审计边界付出的有意成本。

### tmux 优先于纯 PTY

纯 PTY 不能在 daemon 重启后可靠重连，可能连同 Agent 一起消失。tmux 将真实 CLI 进程与 Wave Flow Worker 解耦：浏览器或 daemon 重启后，宿主应重新 attach 同一会话，因此原始 CLI 上下文不丢失，也不产生重复 Agent。

这不是对所有中断的万能恢复：tmux 已退出或会话不可验证时，节点必须是 `interrupted`，而不是假装仍可继续。此时只能由用户显式 `resume` 触发 Journaled Replay。

### tmux 探测无结论不等于会话不存在

Botmux 的 tmux Backend 将会话存在性区分为 `exists`、`missing`、`unknown`。socket 短暂不可用、tmux server 繁忙或探测超时都只能得到 `unknown`；若把它错误解释为“不存在”并新建会话，就可能让两个 Agent 同时执行、同时写同一工作目录。

Wave Flow 因而采用不透明 tmux 会话名、会话身份记录与三态探测：attach 必须同时验证资源存在和 `runId/nodeId/agentSessionId` 匹配；只有 `missing` 才允许走 replay/new-session 路径；`unknown` 必须重试或呈现诊断，绝不创建替代 Agent。浏览器/Worker 断开只 detach；显式停止才在退出证据后 destroy。destroy 未确认时禁止恢复创建副本。

这是“宁可暂时不可用，也不制造双重副作用”的故障处理取舍；代价是 tmux 控制面异常时用户可能需要等待或诊断，收益是不会把一次短暂探测失败放大成并发执行事故。

### Web 终端接管是 P1，不是 P0

Botmux 的 Web Terminal 证明：不能将同一个 PTY 字节流简单广播并允许所有页面回写。多标签会导致并发输入、窗口 resize 互相影响，以及在不同终端宽度上回放 ANSI 重绘序列造成历史错乱。

Wave Flow 将该能力列为 P1：每个 Web 页面使用独立 tmux attach、首次以 tmux 权威 scrollback 初始化、单节点只允许一个 write owner lease。P0 先交付 Phase → Agent 状态、结果、HITL 和恢复；这避免终端渲染与多页面控制复杂度阻塞核心 Workflow/Session Host 正确性。

### 参考 Botmux 的会话工程，不复制 Botmux 产品

Botmux 是“长期 Agent 会话接入协作平台”，Wave Flow 是“动态 Workflow 编排多个真实 Agent 会话”。两者重合的是 PTY/tmux 可靠性，而不是飞书、多人协作或多 Bot 产品面。

因此 P0 直接参考 Botmux 的 node-pty 生命周期、tmux 三态与 attach/detach/destroy、Ready/Input Gate、提交确认，以及 pending ask 的持久化/重连认领；Web Terminal 的独立 attach 与 write-owner lease 是 P1。飞书、远程授权、20+ Adapter、Webhook/定时/on-call、团队 Dashboard 和外部会话 adopt 明确不复制。这个边界防止“参考成熟项目”演变为把无关复杂度整体移植进 Wave Flow。

### 正常 CLI 的首条 Prompt 必须经过就绪门控

交互式 Codex / Claude Code 进程启动后，可能仍处于配置加载、登录、工作目录信任、更新提示或模型选择界面。此时仅凭 `PTY.write()` 成功就投递任务，会导致 Prompt 丢失、写入错误 UI 焦点，或被错误地当作原生对话框操作。

Wave Flow 不自创“看到某段终端文本即可输入”的通用猜测规则，而是以 Botmux 已验证的分层经验为实现基线：tmux/PTy Backend 管会话；每个 CLI Adapter 管各自的 composer 就绪判定；Ready/Input Gate 在确认前持有首条 Prompt；提交后还要由 Adapter 验证任务确实进入该 CLI 的真实会话记录。Runtime 只消费 Adapter 明确给出的 `ready`、`submitted` 或失败结果。

这是一个关键边界：正常 CLI 集成的可靠性来自 Adapter 对原生生命周期的理解，而不是 Runtime 解析 ANSI 文本。当前这是已确认设计，尚需分别以 Codex 与 Claude Code 的真实运行验证其适配完整性。

### HITL 必须持久问题并让原调用重连认领

`wave-flow block` 不能只用 daemon 内存中的 Promise 等待答案：daemon 重启时，tmux 内的 Agent 与 block 子进程可能仍活着，用户回答也可能先于原命令重连。Botmux 的 ask broker 已证明可靠模型是“稳定 requestId + 不可变请求指纹 + durable pending record + reconnect claim + answered-result stash”。

Wave Flow 采用同一原则：block 记录 `blockRequestId`、节点/会话身份、问题与字段 hash、上游输入指纹和绝对 deadline；重启后恢复同一表单而不重复发问；原 block 用相同身份认领；若答案先到则耐久暂存直至原命令认领。requestId 相同但 hash 不同拒绝交付。仅可证明原会话仍存活的 tmux 后端承诺该恢复，PTY 不承诺。

这个设计的关键价值是把“人回答问题”和“答案确实返回到发起问题的那条 Shell 调用”解耦，却仍通过稳定身份重新结合；它避免了最危险的假成功——用户已答、界面已显示完成、Agent 却永久卡住。

### 受控 CLI 上报，而不是终端文本协议

节点完成、失败和业务型提问由同一个 `wave-flow` CLI 上报：`complete`、`fail`、`block`。daemon 校验绑定当前 `runId + nodeId + agentSessionId` 的 capability、节点状态和结果 Schema 后才改变状态。

为什么不用“Agent 最后输出 `{ done: true }`”：自然语言、日志、代码示例或截断终端都可能包含相同文本，无法证明它是最终状态；也无法可靠承载结果、产物、失败原因与调用身份。

为什么 `block` 必须保持原命令等待并由 stdout 返回答案：答案精确回到发起问题的 Shell 调用，而不是依赖当时 CLI TUI 焦点。它让业务 HITL 在同一 Agent 上下文继续，且无需为每个 Coding CLI 配置 MCP。

### 结构化结果是节点控制边界

`wave-flow complete --result-file` 只接收 JSON 对象；若节点声明 `schema`，还要通过运行时 Schema 校验。结果、校验记录和 Journal 必须 durable-first 落盘，之后才能把节点标记为 `completed` 并解锁下游。

这将“Agent 说完成了”变成可由 Runtime 验证的结果契约。Schema 只能保证数据形状，不能保证业务结论正确；高风险结论仍需 verifier、测试、审阅或人工 gate。

### 生成期感知能力，运行期仍必须 fail closed

Workflow Creator Skill 应先读取 `wave-flow capabilities --json`，这是唯一官方机器能力来源，Skill 不自行猜测 CLI 安装或版本。快照以 `available / unavailable / unknown` 三态描述 Adapter、tmux、交互式会话、首条 Prompt 确认和 sandbox；`unknown` 不能当作可用。Skill 据此生成可运行的 `cli + sandbox + 会话` 组合，避免产生“Codex 只读审查”这类表面合理、当前环境却不能实施的 Workflow。

但能力快照不是永久安全证明：CLI 版本、tmux 可用性、Adapter 配置和运行机器都可能在生成后变化。故 Workflow 只记录业务需要，Runtime 在每次启动前重新校验；任何要求无法真实实施时必须拒绝启动，不能为了“跑起来”静默扩大权限或失去持久会话语义。这是生成可用性与运行安全性分层，而不是重复校验。

### 共享 cwd 的一期边界

一期不默认启用 worktree。并发只读节点安全且有价值；并发写入不是一概禁止，但只有在作者能证明目录、文件与逻辑区域均不重叠时才允许。任务名称不同、分别声称“修测试/修类型/修逻辑”都不能证明安全，因为它们经常共同修改同一源文件或配置；存在这种风险时必须顺序执行。

这遵循 Deer Workflow Creator 对独立任务与重叠编辑风险的保守建议。Claude Code 的 worktree 可在未来扩大并行写入范围，但不提前实现它：worktree 同时引入分支命名、基线、合并、冲突、清理、失败恢复和外部副作用语义。先把真实会话、可视化、HITL 和 replay 做成可信闭环；后续再将 worktree 作为显式隔离能力。

### 显式恢复而不是自动重跑

daemon 不因会话丢失而自动创建新 Agent。用户必须执行 `wave-flow resume <run-id>` 或在 Web 点击恢复。原因是节点可能已经写文件、请求外部服务或停在未知状态；无感重跑会放大副作用。

恢复先重新 attach 仍存活的 tmux 会话；只有会话退出或 Run 被停止后，才重放同一 Run 的 Workflow。匹配指纹的完成节点复用 JSON 结果；第一个重启节点及之后节点全部重跑，避免下游基于旧输入继续。Journal 是执行证据，不是事务或 VM 快照。

## 答辩高频问题

### 为什么不直接做一个静态 DAG 画布？

动态 Workflow 的价值恰恰在于代码可以依据上游结果决定分支、循环、并行数量和后续 Prompt。静态 DAG 只能表达预先知道的拓扑。Wave Flow 的主 UI 用 Phase → Agent 提升可读性，但运行图来自实际代码执行，不限制作者的动态性。

### 为什么正常 CLI 会话需要显式 `complete/block/fail`？

交互式 CLI 完成一轮后通常继续等待下一次输入，Runtime 无法从“终端空闲”可靠判断节点终态。显式受控上报将会话状态、结果 Schema 和调度状态连接起来；这也是 Web 可以安全地启动下游节点的前提。

### 为什么不完全采用 Claude Hook？

Claude 的特定工具事件可以作为未来体验优化，但 Codex 没有同等通用结构化提问 Hook。把产品正确性建立在单一 CLI 的私有事件协议上会导致跨 Adapter 不一致。统一 CLI 上报作为基座，原生 Hook 只能是可选加速路径。

### 为什么需要 Journal，还已经有 tmux？

tmux 解决“进程仍存活时如何保持同一上下文”；Journal 解决“进程已退出或用户停止后，如何在同一 Run 内安全复用已完成结果”。两者覆盖不同故障面，不能相互替代。

### 最脆弱的假设是什么？

一期假设 Workflow 作者能遵守共享 cwd 下的并发写入纪律，也假设目标 Coding CLI 能被稳定启动、观察和终止。它尚未证明 worktree 并行写入、复杂多项目状态、长时间高并发 tmux 压力和外部副作用幂等性。答辩时应诚实说明：一期优先保证本地单用户的可观察性与恢复边界，不宣称已解决分布式调度或事务一致性。

## 当前状态

**已验证事实：** 第 1 章已删除旧 Fake/Codex `exec` Runtime、旧 Journal、CLI、示例及其测试，并建立按职责分层的新源码目录与结构测试。

**设计决定：** 不保留旧 API 或可执行兼容入口，防止 README、演示、测试和后续章节将一次性执行语义误认为新架构能力。

**已知限制：** 目录边界不构成 Runtime、正常 CLI Session Host、Web 控制台、受控 HITL、Journal 或 Replay 的实现证据；这些能力必须在后续章节各自形成可验证闭环后才能对外宣称可用。
