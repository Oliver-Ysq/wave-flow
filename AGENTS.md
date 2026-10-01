# Wave Flow 协作约定

## 设计基准与文档

- `docs/wave-flow-design.md` 是项目唯一设计规格。开始新增能力、调整公开接口、改变运行语义或安全边界前，必须先阅读相关章节；已确认的改变必须同步更新该文档。
- Workflow 作者可见的语义必须优先参考 Claude Code Dynamic Workflows 官方文档，以及 Deer Workflow 的公开源码、测试与文档。涉及 `meta`、`agent()`、`phase()`、`parallel()`、`pipeline()`、恢复、暂停或并发时，先核对一手依据；不得凭印象发明接口。
- 只有在两者未覆盖，或“正常交互式 CLI 会话”明确要求扩展时，才能设计 Wave Flow 新能力。必须在规格与最终说明中标为“Wave Flow 新增设计”，说明必要性、替代方案和边界。
- `docs/project-notes.md` 是项目笔记和答辩材料的唯一位置。只记录可复用技术亮点、关键架构/安全取舍、重大失败教训、可验证证据及答辩问题；不要记录工程流水、逐条命令、临时目录、补丁步骤、普通测试通过记录或文件级细节。
- `docs/project-architecture.md` 是当前项目架构图。任何新增、删除或改变主组件、依赖方向、命令路径、状态落盘、安全边界或 Web/daemon 通信时，必须同步更新；主图保持分层、简洁、适合汇报，文件细节放在后续说明。旧 `docs/cli-architecture.md` 已废弃，不得重新引用。
- `docs/wave-flow-chapter.md` 是研发课程路线与实现顺序。新架构实现必须按章节推进：开始一章前先阅读其关联规格和外部参考；本章未形成可验证闭环前，不得提前实现后续章节能力。课程路线变化时同步更新此文件。
- 除被 `.gitignore` 忽略的研发路线与设计文档外，受版本控制的文件不得使用章节编号、`第 N 章`、`Chapter N` 或同义的课程过程表述。README、源码、测试、包配置和提交信息应只描述当前可用能力、稳定架构边界或行为语义。
- `README.md` 面向使用者，只写当前真实可用的功能、安装、命令、示例与已知限制；不写课程、研发过程、计划或未实现能力。
- 新增或修改公开类型、接口、配置、参数、返回值和异常条件时，必须添加字段级中文注释，说明含义、使用时机、默认值/允许值及运行时影响。

## 新架构边界

- 一期是本机单用户的 CLI + Local Web 产品。daemon 只监听 `127.0.0.1`；不添加登录、多人协作、云端同步、远程控制或可视化 Workflow 编辑。
- Workflow 是用户明确指定的本地 TypeScript 文件，是受信任扩展模块；仅允许本地加载，禁止 URL、自动下载和未知来源 Workflow。
- 作者 API 优先使用 `agent()`、`phase()`、`parallel()`、`pipeline()`、`log()`。不要新增或延续 `ctx.agent()`、每个 Agent 的 `phase` 字段等偏离 Claude/Deer 基线的接口。
- `meta` 是顶部纯字面量，包含 kebab-case `name`、非空单行 `description`、有序唯一的 `{ title }` `phases`，以及可选 JSON-safe `exampleArgs`。一期 `meta` 必填，`phase(title)` 必须精确匹配已声明标题。
- 每个 `agent()` 必须提供 Run 内唯一的稳定 `id` 与 `cli: "codex" | "claude"`。一个 Agent 节点绑定一个真实 tmux/PTY 会话和一个正常交互式 CLI 进程；下游不得隐式复用其聊天历史。
- Runtime 负责动态调度和节点状态；Session Host 负责 tmux/PTY 生命周期与终端字节转发；Adapter 只负责启动特定正常 CLI；Control Server 负责验证 `complete/block/fail`；Web 只展示和控制 Run。不要让任一层跨越该职责边界。
- 默认 UI 是 Phase → Agent 层级；不要把复杂自由 DAG 当作主界面。真实依赖来自 Workflow 的实际调用与显式输入，未来可作为次级视图。

## Agent 会话、状态与安全

- 不再新增以 `codex exec --json` 为核心的一次性节点实现。真实节点必须通过正常交互式 Codex 或 Claude Code CLI，在 tmux（生产默认）或 PTY（开发/故障降级）中运行。
- 不从终端 ANSI、自然语言“完成”或空闲提示推断节点状态。只有受管会话中的 `wave-flow complete`、`wave-flow block`、`wave-flow fail` 能改变业务状态。
- `complete` 只在 JSON 结果、Schema 校验记录和 Journal 均耐久落盘后生效；`block` 只使节点进入等待输入，答案必须回到原 `block` 命令 stdout；`fail` 是 Agent 明确业务失败。用户停止必须是 `cancelled`，未知进程/会话异常必须是 `interrupted`，不得混为 `failed`。
- Agent 上报必须绑定 `runId + nodeId + agentSessionId` 的会话 capability。能力的用途是隔离本机无关进程和其他节点，不能将其误表述为防御已控制该 Agent 终端的主体。
- 一期默认共享项目 cwd：并行只读允许；并行写入仅限可证明路径不重叠；同一文件或逻辑区域存在冲突风险时必须顺序执行。不要假设已有 worktree 隔离或自动合并。
- `sandbox` 约束 Adapter 启动的 Agent CLI，而不是 Workflow JavaScript。只支持 `read-only` 与 `workspace-write`；不要引入危险全权限模式。
- Codex 没有可靠的普通结构化提问事件。不要使用正则或屏幕解析将其自然语言问题转为表单；必须保留原生终端交互兜底。

## 运行、恢复与可观测性

- 关闭浏览器不停止 daemon 或 Agent。daemon 重启时，如 tmux 和 CLI 仍存活，必须重新 attach 原会话，禁止创建重复 Agent。
- `wave-flow resume <run-id>` 和 Web 恢复按钮是唯一恢复入口。不得因检测到会话丢失而自动重跑，避免重复副作用。
- Replay 仅在同一个 run 内生效。匹配 Workflow hash、cwd、Runtime 版本、id、调用顺序、CLI、输入、sandbox、model 和 Schema 指纹的 `completed` 节点才可复用；第一个重启节点之后的下游节点不得复用旧结果。
- Journal 是执行证据，不是 VM 快照，不回滚文件或外部系统。对写入类任务应将高风险副作用置于明确、可验证的后置节点。
- 运行事件必须包含时间、run id、node id、会话 id 和诊断原因。Web 的权威状态来自 daemon 状态机，而不是终端输出。
- 必须实现 Run 并发、进程/tmux 会话和总 Agent 节点的保守可配置护栏；具体默认数值需由实现验证决定，不能凭空写入设计。

## 实现与验证

- 使用 Bun。优先运行 `bun run check`、`bun test` 和 `git diff --check`；行为改动应覆盖正常路径、输入错误、边界条件和不应发生的副作用。
- 新的真实 CLI Adapter、tmux/PTY Session Host、Control Server、Journal/Replay 和 Web API 必须可独立测试。测试不应依赖真实模型服务、用户登录或不稳定终端文本。
- 不要用未来能力的空接口占位。工作按已确认范围渐进：先建立可验证的最小端到端闭环，再增加 worktree、复杂表单、Claude Hook 优化或桌面端。
- 当前旧 Runtime、Fake Adapter、旧 `codex exec` 代码属于历史实现；在新架构迁移前不得把它们表述为新规格已实现的能力。

## 刁钻考官复盘

- 完成关键设计、架构调整、关键功能或疑难修复后，以刁钻答辩考官视角复盘。只有结论能解释系统级取舍、可迁移风险或答辩问题时，才更新 `docs/project-notes.md`。
- 每条复盘优先回答：最脆弱的假设是什么？为何不用更直接替代方案？证据证明了什么、没有证明什么？什么规模或场景会失效？答辩时如何简洁且诚实地解释取舍？
- 记录时严格区分已验证事实、设计决定与已知限制/待验证假设；不得用未来计划掩盖当前缺口。

## Git

- 未经用户明确要求，不得创建 Git commit、push、修改远程仓库或创建 Pull Request。
- 用户说 `ok`、`可以`、`同意` 仅表示同意当前设计或实现范围，不表示 Git 提交或推送授权。
- 提交或推送前，先说明包含的文件和影响范围；只在用户明确说“commit”“提交”“push”或“推送”后执行。
