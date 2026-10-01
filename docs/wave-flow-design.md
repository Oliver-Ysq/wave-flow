# Wave Flow：本地可视化动态工作流

## 状态与定位

本文是 Wave Flow 的唯一设计规格。此前以 `codex exec --json` 为核心的一次性 Agent Runtime、对应课程和实现假设已经废弃；遗留代码不代表本规格已落地。今后新增设计与实现以本文为准。

Wave Flow 是本机单用户的动态工作流产品：用户以 TypeScript 编写 Workflow，代码在运行时动态创建 Agent 节点；每个节点托管一个真实、长期存活、可交互的 Codex 或 Claude Code 正常 CLI 会话。CLI 与 Web 控制台共同管理本地 daemon；二期桌面端只复用 daemon API，不改变运行语义。

目标：

- 保留 Claude Code Dynamic Workflows 与 Deer Workflow 的“代码即编排”表达力。
- 将每个 Agent 变成可查看终端、可停止、可交互、可审计的 Web 实体。
- 不从终端文本猜测业务语义；只有受控协议能改变调度状态。
- 让浏览器/daemon 重启、会话重连和显式恢复具备可解释的行为。

一期不是云服务、多人协作工具或可视化 Workflow 编辑器。

## 参考依据与一致性边界

Workflow 作者可见语义按以下优先级设计：

1. [Claude Code Dynamic Workflows 官方文档](https://code.claude.com/docs/zh-CN/workflows)的可验证行为；
2. [Deer Workflow](https://github.com/deerwork-ai/deer-workflow)公开源码、测试与文档；
3. 仅当两者未覆盖，或正常交互式 CLI 会话必然要求扩展时，定义 Wave Flow 新能力，并明确标为新增设计。

直接参考入口：

- [Deer Workflow Creator Skill](https://github.com/deerwork-ai/deer-workflow/blob/main/skills/workflow-creator/SKILL.md)：Workflow 文件形态、`meta`、`phase()`、`parallel()`、`pipeline()`、并发写入边界与作者约束。
- [Botmux](https://github.com/deepcoldy/botmux)：正常 Coding CLI 的 PTY/tmux 会话宿主、Ready/Input Gate、首条 Prompt 提交确认、可恢复提问与 Web Terminal 的工程参考。

### 已验证基线

| 主题 | Claude Code | Deer Workflow | Wave Flow |
| --- | --- | --- | --- |
| 编排 | 脚本保存分支、循环、并发与中间值 | TypeScript Workflow 保存同类逻辑 | 代码定义 Workflow，不使用静态 DAG |
| Agent | `agent(prompt, options)` | `agent(prompt, options)` | 同形 API，不以 `ctx.agent()` 为作者接口 |
| 阶段 | `phase(title)` 为后续 Agent 分组 | `phase(title)` 改变当前 Workflow 阶段 | 同样采用 `phase(title)` |
| 并行 | `parallel()` 并发运行并等待 | `parallel([() => task()])`，失败项为 `null` | 采用 Deer 已验证的 thunk 形式 |
| 管道 | `pipeline(items, ...stages)` | 同名且每个 item 独立流动 | 同语义 |
| 结构化结果 | `schema` 返回 JSON | `schema` 约束最终输出 | `schema` 约束 `complete` 的 JSON 结果 |
| 恢复 | 同会话按启动顺序重放、复用有效完成结果 | 当前公开 Runtime 无跨进程恢复 | 采用同 Run、显式 replay |

### Wave Flow 新增能力

以下不应伪称为 Claude 或 Deer 的已有功能：

- `agent()` 必须有稳定 `id`，绑定节点、终端会话、上报身份与 Journal。
- 每个节点启动正常交互式 `codex` / `claude` CLI，不使用一次性 exec/print。
- `wave-flow complete`、`wave-flow block`、`wave-flow fail` 是节点控制协议。
- tmux / PTY 承载真实会话，终端通过 WebSocket 投递到 Web。
- `block` 是业务型 HITL；Claude 官方明确 Workflow 本身不支持中途用户输入。

## 产品形态与一期范围

### 本机单用户

- daemon 只监听 `127.0.0.1`；不做登录、多人、云端同步或公网终端控制。
- 关闭浏览器不停止 daemon，也不停止正在运行的 Agent。
- 一次 Run 属于一个本地项目 cwd；不同 Run 绝不自动复用结果。
- Web 是运行控制台；Workflow 仍在 IDE 中以 TypeScript 编写。

### 两期演进

```text
一期：CLI + Local Web
  ├─ 动态 Workflow Runtime
  ├─ 本地 daemon、tmux / PTY 会话宿主
  ├─ Codex / Claude Code 正常 CLI Adapter
  ├─ CLI：run / serve / inspect / resume
  └─ Web：Phase → Agent、终端、HITL、停止、恢复

二期：Desktop App
  └─ 复用同一 daemon API，补托盘、通知和多项目体验
```

一期不做：图形化编辑、多人/远程控制、默认 worktree、自动分支合并、自动重跑、从 Codex 自然语言终端文本识别表单、未知第三方 Workflow 托管。

## 总体架构

```text
TypeScript Workflow（唯一真源）
  │ agent / phase / parallel / pipeline
  ▼
Wave Flow daemon
  ├─ Workflow Runtime：动态调度节点
  ├─ Run Store + Journal：状态、结果、事件、replay 证据
  ├─ Agent Session Host：每节点一个 tmux / PTY 会话
  ├─ CLI Adapters：Codex、Claude Code 正常交互式启动
  ├─ Node Control Server：complete / block / fail 上报
  └─ Local HTTP + WebSocket API
       ├─ wave-flow CLI
       └─ Web 控制台
```

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Runtime | 加载 Workflow、执行作者原语、生成实际节点 | 解析 CLI TUI 语义 |
| Session Host | 建立/附着/终止 tmux 或 PTY，转发输入输出 | 判断文本是否代表完成 |
| Adapter | 组装和启动正常 CLI，声明能力 | 决定 Workflow 拓扑 |
| Control Server | 校验节点上报、改变状态、唤醒 `block` | 接受任意进程伪造状态 |
| Journal | 同一 Run 的节点、输入指纹、终态、回答和事件 | 回滚文件、Git 或外部系统 |
| Web | 展示与操作 Run | 编辑或保存 Workflow 源码 |

## 状态目录与命令

```text
.wave-flow/
  runs/<run-id>/
    manifest.json                 # Run 身份、Workflow 指纹、项目 cwd
    journal.jsonl                 # 追加式事件
    nodes/<node-id>/
      result.json                 # complete 接受后的 JSON 结果
      terminal.log                # 终端记录或索引
      session.json                # tmux / PTY 恢复坐标
  runtime/                        # daemon socket、锁与版本信息
```

```bash
# 用户主动使用
wave-flow run <workflow.ts> [--input '<json>']
wave-flow serve
wave-flow inspect <run-id>
wave-flow resume <run-id>

# 仅在受管 Agent 会话内使用
wave-flow complete --summary <text> --result-file <path>
wave-flow block --question <text> [--input <field-spec> ...]
wave-flow fail --reason <text>
```

`run` 确保 daemon 存在并返回 Run 控制台地址；`serve` 只启动 daemon；`resume` 永远由用户显式调用，Web 的恢复按钮调用同一 API。

## Workflow 文件契约

Workflow 是用户明确指定的当前项目内 TypeScript 文件，是受信任的本地扩展模块，不是未知第三方 JavaScript 沙箱。

### 文件与元数据

`meta` 必须是文件顶部静态导入之后的第一条非 import 语句；静态 import 必须全部位于 `meta` 之前，且运行时值导入只允许本机已安装或链接的受信任 `wave-flow` 包。`meta` 只能含对象、数组、字符串、有限数字、布尔值和 `null`；禁止变量、函数调用、展开、计算属性和模板字符串。当前不支持动态 import 或相对路径运行时依赖，避免 Workflow 指纹与实际执行依赖图不一致；类型 import 可用于作者的 TypeScript 注解。`wave-flow` 包自身的安装与链接是本机开发环境信任边界，不由 Workflow 加载器重新解析或沙箱化。

```ts
export const meta = {
  name: "security-review",
  description: "扫描、验证并汇总代码库中的安全风险。",
  phases: [
    { title: "扫描" },
    { title: "验证" },
    { title: "汇总" },
  ],
  exampleArgs: { target: "src" },
};
```

```ts
type WorkflowMeta = {
  /** 稳定标识，必须为 kebab-case。 */
  name: string;
  /** 面向用户的非空单行简介。 */
  description: string;
  /** 有序且标题唯一的可视阶段计划。 */
  phases: readonly { title: string }[];
  /** 可选、JSON-safe 的最小可运行输入。 */
  exampleArgs?: Record<string, JsonValue>;
};
```

一期要求 `meta` 必填，因为 Phase → Agent 是产品主视图；Deer 的无 meta 兼容路径不适合 Wave Flow。`phase(title)` 必须精确匹配 `meta.phases` 某项；未声明标题是错误，不创建临时视觉分组。

### 编排原语

```ts
agent<T = Record<string, unknown>>(prompt: string, options: AgentOptions): Promise<T | null>;
phase(title: string): void;
parallel<T>(tasks: readonly (() => Promise<T>)[]): Promise<Array<T | null>>;
pipeline<T>(items: readonly T[], ...stages: PipelineStage[]): Promise<Array<unknown | null>>;
log(message: string): void;
```

- `agent()` 创建节点与独立真实 CLI 会话。
- `phase()` 改变当前 Workflow 的共享阶段；之后创建的 Agent 自动归属该阶段。
- `parallel()` 使用 Deer 的惰性 thunk 数组；全部启动、顺序回收；单项失败为 `null`，不取消兄弟任务。
- `pipeline()` 让每个 item 独立经过阶段；一个 item 失败会跳过其后续阶段并在原位置返回 `null`，不是全局 Barrier。
- 需要全局聚合、排序、去重或阶段 Barrier 时，用普通 `await` 和 TypeScript 拆开表达。
- 禁止在 `parallel()` thunk 或 `pipeline()` stage 内调用 `phase()`；共享阶段并发改变会产生竞态。

Workflow 只做编排与确定性数据转换；文件、Shell、网络和语义判断由 Agent 完成，对齐 Claude 的“脚本协调，Agent 操作”边界。

## Agent 节点与正常 CLI 会话

```text
一次 Workflow Run
  └─ 一个 agent() 调用
       └─ 一个唯一 node id
            └─ 一个 tmux / PTY 会话
                 └─ 一个正常 Codex 或 Claude Code CLI 进程
```

节点会话不被后续节点隐式复用；下游只取得上游 `complete` 的 JSON 结果。`id` 必须显式、稳定且 Run 内唯一，最大 120 字符，允许字母、数字、`-`、`_`、`.`、`:`、`/`；重复 id 使 Run 失败。

```ts
type AgentOptions = {
  /** Wave Flow 节点身份；同一 Run 内唯一，必填。 */
  id: string;
  /** 正常交互式 CLI Adapter，必填。 */
  cli: "codex" | "claude";
  /** Web 展示名；省略时使用 id。 */
  label?: string;
  /** 工作目录；默认 Run 的项目 cwd。 */
  cwd?: string;
  /** Adapter 支持时请求的模型。 */
  model?: string;
  /** 节点 JSON 结果的运行时 Schema。 */
  schema?: JsonSchema;
  /** 一期只读或当前项目可写；默认只读。 */
  sandbox?: "read-only" | "workspace-write";
  /** 显式上游输入，参与初始上下文和 replay 指纹。 */
  input?: Record<string, JsonValue>;
};
```

`label`、`schema` 对齐 Claude；`cwd`、`model`、`schema`、`sandbox` 对齐 Deer；`id`、`cli`、`input` 是 Wave Flow 可见会话与确定性 replay 所需扩展。一期不开放 `env`、任意 `extraArgs`、额外可写目录或作者自带 `AbortSignal`，以避免绕过 Adapter 和安全边界。

### Adapter 能力快照与 fail-closed 门控

`wave-flow capabilities --json` 是唯一官方的、机器可读的环境能力来源；Workflow Creator Skill 必须消费它，不能自行猜测 CLI 安装、版本或 sandbox 支持。最小稳定结构如下：

```json
{
  "version": 1,
  "host": {
    "platform": "darwin",
    "tmux": {
      "status": "available",
      "persistentSessions": "available"
    }
  },
  "adapters": {
    "codex": {
      "status": "available",
      "interactiveSession": "available",
      "verifiedPromptDelivery": "available",
      "persistentTmuxSession": "available",
      "sandbox": {
        "readOnly": "unavailable",
        "workspaceWrite": "available"
      }
    }
  }
}
```

所有可探测能力采用 `"available" | "unavailable" | "unknown"` 三态，而不是裸布尔值。`unknown` 表示探测无结论，不能被 Creator 或 Runtime 当作可用；这沿用 tmux 三态探测的安全原则。`interactiveSession` 不把 headless/print 模式当作满足；`verifiedPromptDelivery` 仅在 Adapter 已实现并验证“composer 就绪 → 提交 Prompt → 确认进入会话”时为 available；sandbox 只列 Wave Flow 在当前机器、CLI 版本和 Adapter 中可证明实际实施的权限。

Creator Skill 根据快照选择组合：并行只读审查只选择 `status`、`interactiveSession`、`verifiedPromptDelivery`、`persistentTmuxSession` 与 `sandbox.readOnly` 都为 available 的 Adapter；项目写入只选择 `workspaceWrite` 为 available 的 Adapter，再按写入范围决定并行或顺序。无满足组合时，Skill 必须说明缺失能力与可选替代方案，而不是生成表面可运行的 Workflow。

能力探测结果属于当前环境，不写入 Workflow 源码；Workflow 只声明业务所需的 `cli` 与 `sandbox`。

生成期校验只提升可用性，不替代安全边界。运行时必须重新由 Adapter 和 Session Backend 检查实际能力：请求可真实实施时才启动，并在 Journal/Web 记录实际生效策略；任何会话持久性、已验证 Prompt 投递或 sandbox 要求无法满足时，节点必须在启动前以明确诊断失败，绝不静默降级为更宽松权限或更弱恢复语义。

生产默认后端为 tmux。`TmuxSessionBackend` 以 Botmux 已验证的会话管理原则实现：

- tmux 会话名使用仅含受控字符的不透明内部标识，例如 `wf-<run-short>-<session-hash>`；不得直接拼接用户可读的 `nodeId`。
- 创建时写入 `runId`、`nodeId`、`agentSessionId`、CLI 和创建时间的会话身份记录。重新 attach 前必须同时确认会话存在且身份记录完全匹配，不能因同名资源存在就接入。
- 存在性探测必须是 `exists`、`missing`、`unknown` 三态。只有 `missing` 才证明会话不存在；tmux socket 超时、繁忙或连接失败属于 `unknown`，此时重试或展示诊断，绝不创建替代 Agent。
- detach 与 destroy 必须分离：浏览器、Worker 或 daemon 断开只 detach 观察者，真实 tmux/CLI 继续运行；用户停止节点时先发送中断、等待退出证据，再 destroy tmux 会话。destroy 失败或退出未确认时，必须保留“终结未确认”状态，禁止 resume 创建替代 Agent。

daemon 重启时，已确认存活且身份匹配的会话重新 attach；已确认 `missing` 的会话节点可标记 `interrupted` 并等待用户显式 resume；`unknown` 不能被当作 `missing`。PTY 只作开发/故障降级，不保证重启后存活。终端字节写入节点记录，并通过 WebSocket 原样投递到 Web xterm；用户输入原样写回会话。

### 文件与并发

一期默认所有 Agent 共享项目 cwd。并行策略按写入范围判定，而不是简单按“是否写入”判定：

- 多个只读任务可以并行，且推荐使用 `parallel()`。
- 多个写入任务只有在 Workflow 作者能够证明目录、文件与逻辑区域互不重叠时才能并行；每个任务必须显式限制自己的 cwd 和目标范围。
- 多个写入任务可能接触同一文件、共享配置、测试或同一逻辑区域时，必须顺序执行；不能因为任务标题不同就假定安全。
- 需要并行修改、但无法证明范围不重叠时，不得生成并行共享 cwd Workflow；等待后续 worktree 隔离能力。

此边界直接遵循 Deer Workflow Creator 对独立任务、重叠编辑风险和共享工作目录的保守建议。Claude Code 的 worktree 是扩大并行写入能力的可选隔离路径；一期尚未实现分支、合并、冲突和清理语义，不能假装已有隔离。

## 受控上报与 HITL

### 原则与状态机

自然语言和终端输出只用于展示。只有受管会话内的 `wave-flow` CLI 能改变调度状态。启动会话时，Wave Flow 注入绑定 `runId + nodeId + agentSessionId` 的短期 capability；daemon 必须校验 capability、节点/会话身份、当前状态和字段 Schema。它防止其他本机进程或节点伪造上报，不试图防住已控制该 Agent 终端的人。

```text
queued → running → waiting_for_input → running → completed
                    │
                    ├──────────────────────────→ failed
                    ├──────────────────────────→ cancelled
                    └──────────────────────────→ interrupted
```

| 状态 | 来源 | 含义 |
| --- | --- | --- |
| `queued` | Scheduler | 等待依赖或资源，尚未启动 CLI。 |
| `running` | Scheduler | 会话已启动，正在执行。 |
| `waiting_for_input` | `wave-flow block` | 原 Agent 命令等待人类答案。 |
| `completed` | `wave-flow complete` | 校验结果已耐久落盘。 |
| `failed` | `wave-flow fail` | Agent 确认任务无法完成。 |
| `cancelled` | 用户/Runtime | 人为停止或上游不可继续，不等同业务失败。 |
| `interrupted` | Runtime | 会话异常丢失，无法证明完成或失败。 |

### `complete`

```bash
wave-flow complete \
  --summary "已完成鉴权检查" \
  --result-file ".wave-flow/results/scan-auth.json"
```

`result-file` 必须为 JSON 对象；节点有 `schema` 时还必须通过 Schema。daemon 只有在结果、校验记录和 Journal 已耐久落盘后，才能置节点为 `completed` 并让 `agent()` 返回对象。

### `block`

```bash
wave-flow block \
  --question "是否允许修改生产配置？" \
  --input "allowProductionConfig:boolean:required"
```

命令注册问题后保持运行，节点变为 `waiting_for_input`。Web 在 Agent 方块中显示表单；用户提交后，daemon 校验回答并将 JSON 写到该 `block` 命令 stdout，命令返回，Agent 在同一 Shell 命令与 CLI 上下文继续。首版仅支持 `string`、`boolean`、`number`、`enum`，禁止数组、嵌套对象和条件字段。

`block` 不是仅存于 daemon 内存的一次长轮询。为支持 daemon 重启后仍存活的 tmux Agent，命令首次注册时必须创建并持有稳定的 `blockRequestId`，Journal 记录 `runId`、`nodeId`、`agentSessionId`、`requestHash`、字段定义、创建时间和绝对 `deadlineAt`。其中 `requestHash` 覆盖问题、字段规则与上游输入指纹。

daemon 重启后，未决问题恢复为 dormant 状态，Web 继续显示同一表单但不得重复创建。仍在 tmux 中运行的原 `block` 命令以相同 `blockRequestId + requestHash` 重连并认领等待者：若用户尚未回答，恢复原截止时间；若用户已先回答，daemon 必须从耐久暂存交付该答案到原命令 stdout。相同 request id 但 request hash 不同必须拒绝认领，绝不将旧答案注入新问题。PTY 后端不承诺此恢复能力；仅会话存活可被验证的持久后端启用它。

### `fail`、取消与中断

```bash
wave-flow fail --reason "无法连接到目标测试环境"
```

`fail` 使当前 `agent()` 返回 `null`。`block` 不是终态；回答后继续等待 `complete` 或 `fail`。用户停止节点/Run 是 `cancelled`，CLI 异常退出、tmux 无法重连等不确定情况是 `interrupted`；两者绝不能伪装为 `failed`。

## Web 控制台

主视图参考 Claude Code 的 Phase → Agent 层级，不把动态依赖线塞入默认自由 DAG：

```text
Run
  ├─ Phase：扫描
  │    ├─ scan:auth
  │    ├─ scan:injection
  │    └─ scan:payment
  ├─ Phase：验证
  │    └─ verify:auth
  └─ Phase：汇总
       └─ summary
```

一期界面包括：

1. Run 总览：Workflow 名称、cwd、时间、状态、停止/恢复入口；
2. Phase 导航：有序 Phase、进度、活动/失败/等待标识；
3. Agent 卡片：id/label、CLI、模型、状态、耗时、摘要、replayed 标记；
4. Agent 详情：生命周期事件、JSON 结果、停止操作；
5. HITL 面板：`waiting_for_input` 节点的受 Schema 约束表单。

代码中的 `await`、明确输入和实际调用序列是真实依赖；一期默认 UI 不渲染交叉连线。后续可增加次级运行关系图，但不替代 Phase → Agent 主视图。

### P1：Web 终端观察与接管

Agent 终端嵌入 Web 不属于 P0 最小闭环，作为 P1 建设；它直接采用 Botmux 的 tmux Web Terminal 原则，而非将一个 PTY 字节流简单广播给所有浏览器标签：

```text
真实 tmux Agent 会话
  ├─ daemon 的观察/管理连接
  ├─ Web tab A 的独立 tmux attach PTY
  └─ Web tab B 的独立 tmux attach PTY
```

- 每个 Web 客户端都有独立 attach，关闭页面只销毁自己的 viewer，不影响真实 Agent。
- 首次连接从 tmux 的权威屏幕和 scrollback 初始化 xterm，再接收实时字节；不得重放 daemon 自进程启动以来积累的原始 ANSI 流。
- 同一节点一次只有一个 Web terminal write owner；其他标签只读。用户点击“接管终端”获得短期 write lease，主动释放、断连或 lease 超时后回收，其他标签才能接管。
- 一期为本机单用户，不复制 Botmux 的远程 token/多用户授权体系；write lease 用来解决同一用户多个标签同时输入、resize 与 TUI 状态不可解释的问题。

## Journaled Replay 与显式恢复

恢复只能由用户执行：

```bash
wave-flow resume <run-id>
```

Web 的恢复按钮调用同一 API。daemon 不会检测进程退出后自动重跑，避免无感重复写入或外部副作用。

```text
会话仍存活
  → attach 原 tmux 会话
  → 保留原 CLI 上下文，不重跑

会话已退出 / Run 已停止
  → 用户显式 resume
  → 重放同一 Run 的 Workflow
  → 复用有效完成结果，从第一个失效点重新调度
```

Replay 规则：

1. 校验 Workflow 内容哈希、项目 cwd 与 Runtime 兼容版本；不匹配拒绝恢复。
2. 以 `id`、调用顺序、CLI、规范化 `input`、cwd、sandbox、model、Schema 指纹匹配 Journal。
3. 已 `completed` 且匹配的节点直接返回已持久化 JSON，并标为 `replayed`。
4. `failed`、`cancelled`、`interrupted` 和未 `complete` 节点必须重新启动。
5. 第一个重启节点之后的所有后续节点都不得复用旧结果，避免使用过期上游输入。
6. 已回答 `block` 只有请求、字段和上游输入指纹相同才回放原 stdout；否则重新提问。
7. Replay 严格限于当前 `runId`，不是跨 Run 缓存。

该方向对齐 Claude 的“按启动顺序恢复、从第一个失效 Agent 起重跑后续工作”。Journal 只是证据，不是 VM 快照：不会回滚文件、恢复外部状态或保证副作用幂等。高风险写入应放在明确、可验证的后置节点。

## 事件、护栏与安全

Journal 至少记录：

```text
run.created, workflow.meta,
phase.started / phase.completed,
agent.created / agent.started / agent.blocked / block.answered,
agent.completed / agent.failed / agent.cancelled / agent.interrupted / agent.replayed,
run.completed / run.failed / run.cancelled / run.interrupted
```

`agent.completed` 只能在结果与 Journal 耐久落盘后发布；Web 状态来自 daemon 状态机，不能从终端猜测。事件必须具备时间、run id、node id、会话 id 和可诊断原因。

Claude 有并发与总 Agent 护栏，Deer 的 `parallel()` 不承诺调度上限。Wave Flow 必须提供可配置且保守的 Run 并发、进程/tmux 会话和总节点上限；具体默认数值由实现实测确定，不能在规格中编造。超限节点保持 `queued` 并在 Web 说明原因；取消和资源限制不能误标成业务 `failed`。

安全边界：Workflow 是本地受信任代码，只加载用户指定的本地 TypeScript 文件；`sandbox` 是对 Agent CLI 的 Adapter 权限配置而非 Workflow JS 沙箱；一期只支持 `read-only` 和 `workspace-write`。Codex 没有可靠的普通结构化提问事件，用户必须能直接在节点终端回答；Claude Hook 未来可作为体验优化，但正确性不依赖任何一家 CLI Hook。

## Botmux 参考边界

Wave Flow 参考 Botmux 的 PTY/tmux 会话工程经验，但不将 Botmux 当作产品底座。P0 必须复用或忠实适配的原则是：

1. `node-pty` 的正常 CLI 生命周期封装：spawn、输入/输出、resize 与 exit；
2. tmux 的功能性探测、会话身份、三态 liveness、attach/detach/destroy 分离；
3. CLI Adapter 专属的 Ready/Input Gate 与首次 Prompt 提交确认；
4. `block` 的稳定 request id、持久 pending record、重连认领与答案暂存。

P1 才建设 Botmux 风格的 Web Terminal：每个浏览器标签独立 tmux attach、tmux 权威 scrollback 初始化、单 write-owner lease 以及断连/超时回收。

以下 Botmux 能力明确不在 Wave Flow 一期或本规格范围：飞书应用/群聊/话题/卡片、多人身份和远程终端授权、20+ CLI 与云 Agent、定时任务/Webhook/on-call/语音、多 Bot 协作、团队 Dashboard/多 daemon 聚合，以及 adopt 外部用户 tmux 会话。

Botmux 的定位是将长期 Agent 会话桥接给协作平台；Wave Flow 的定位是由动态 Workflow 编排多个真实 Agent 会话，并提供节点级结果、HITL 与同 Run replay。实现可局部借鉴或复用 Botmux Backend/Gate 的设计与测试思路，但 Workflow Runtime、Phase → Agent 状态机、`complete/block/fail`、Journaled Replay、capabilities 和 Local Web API 由 Wave Flow 自己负责。

## 一期验收标准

1. 含 `meta`、`phase()`、`parallel()`、`pipeline()` 的 TypeScript Workflow 能加载并校验。
2. 每次 `agent()` 产生 Web 可见的正常 Codex 或 Claude Code 交互式会话状态与生命周期记录。
3. `complete` 使 Web 显示完成，且 `agent()` 获得可传递 JSON 对象。
4. `block` 在 Web 显示表单，答案精确回到原命令 stdout，Agent 在原会话继续。
5. `fail`、用户取消和会话中断在 UI/Journal 中可区分。
6. 浏览器或 daemon 重启后，存活 tmux 会话可重连且不产生重复 Agent。
7. 显式 `resume` 能回放匹配的完成节点；第一个失效节点及之后节点重跑。
8. Workflow 或输入指纹变化时，恢复拒绝复用不匹配结果。

Web 内嵌终端、独立 tmux attach、终端 write lease 与权威 scrollback 初始化是 P1 验收项，不是上述 P0 完成前提。
