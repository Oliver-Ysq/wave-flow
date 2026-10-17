# 编排模式

以下是设计指引，不是 API。示例均按受限草案形状书写（无 import/export）；受信任模块
只需补上 `import { … } from "wave-flow"` 与 `export`。

## 计划 → 扇出 → 汇总

先用一个结构化 Agent 产出计划，再用 `parallel()` 执行独立子任务，最后交给一个汇总
Agent。计划结果用 `schema` 约束，并处理 `null`：

```ts
phase("计划");
log(`## 计划\n正在把主题拆解为独立调研任务。`);
const plan = await agent(`针对主题「${args.topic}」制定调研计划，给出互相独立的任务清单。`, {
  id: "planner",
  cli: "codex",
  schema: {
    type: "object",
    properties: { tasks: { type: "array", items: { type: "string" } } },
    required: ["tasks"],
    additionalProperties: false,
  },
});
if (!plan) throw new Error("计划 Agent 未能交付结构化结果。");

phase("调研");
log(`## 调研\n并行执行 **${plan.tasks.length} 个任务**，结果会随完成逐个出现。`);
const raw = await parallel(
  plan.tasks.map((task, index) => async () => {
    log(`- 开始 \`${task}\``);
    const finding = await agent(`完成这项独立调研任务：\n${task}`, {
      id: `research-${index + 1}`,
      cli: "codex",
    });
    if (finding) log(`- 完成 \`${task}\``);
    return finding;
  }),
);
const findings = raw.filter((item) => item !== null);

phase("汇总");
return agent(`基于以下调研结果给出结论：\n${JSON.stringify(findings)}`, {
  id: "synthesizer",
  cli: "codex",
});
```

`agent()` 的 `id` 必须在编写时或从输入确定性派生；不要用随机值或时间戳，否则
replay 指纹会变化。

## 逐 item 流水线

每个 item 独立经过相同阶段时用 `pipeline()`；`agent()` 的稳定 `id` 编进 item：

```ts
phase("审校");
const reviewed = await pipeline(
  args.sections.map((section, index) => ({ draftId: `draft-${index + 1}`, editId: `edit-${index + 1}`, section })),
  (value) => {
    const item = value as { draftId: string; section: string };
    return agent(`起草小节：\n${item.section}`, { id: item.draftId, cli: "codex" });
  },
);
```

需要全部小节的全局终审不属于 pipeline：先等流水线完成，再发起一次单独的 Agent 调用。

## 屏障之间的全局操作

一个操作需要看到全部结果时，先结束扇出，在普通代码里完成确定性处理，再扇出下一轮：

```ts
const candidates = (await parallel(discoveryTasks)).filter((item) => item !== null);
const unique = dedupeByStableKey(candidates); // 精确去重属于代码，不属于 Agent
const verdicts = await parallel(unique.map((candidate) => () => verify(candidate)));
const confirmed = unique.filter((_, index) => verdicts[index] !== null);
```

## 独立验证

对发现、审计或高风险评审，让每一个候选结论由一个独立的 Agent 复核；`parallel()`
保持输入顺序，用索引保持关联，判空时不要位移索引。

## 代码改动任务

Wave Flow 新增宿主边界：主控保留OS写隔离、原生读取与四窄MCP；Worker使用可信原生CLI/Home/权限，不做额外OS文件隔离。read-only/workspace-write表示任务意图，不保证不可越界。整worktree v2授权保存实际tracked与非ignored untracked（排除未跟踪node_modules），不预填paths；独立分支可修改同一文件，必须显式集成。完成后冻结唯一完整ready来源，用户读diff后明确squash合入本机目标分支，不自动合入/push。作者不新增worktree/commit/merge接口，不让Worker自行提交。cwd/prompt/lease不能阻止可信Worker写其他目录，外部影响不由Git证明。

给改动类 Agent 明确的项目 `cwd`、`workspace-write` 权限、验收标准和它应运行的检查。
Wave Flow 的作者 API 不声明 worktree 或 commit。Desktop 会对固定 `workspace-write` 节点
要求用户冻结整个 Git 工作区授权：独立worktree允许修改同一文件，相同工作区分组表示
同一改动链顺序复用；独立分支须后续显式集成。未取得此配置、动态写节点无法核验、
或 Adapter 未通过Worker Control验证时 fail closed。cwd不是OS安全边界：

```ts
phase("实现");
await agent(`实现需求并运行相关测试：\n${args.requirement}`, {
  id: "implementer",
  cli: "codex",
  cwd: args.repository,
  sandbox: "workspace-write",
});

phase("复审");
return agent(`复审刚才的实现，修复已验证的问题并再次运行检查。`, {
  id: "reviewer",
  cli: "codex",
  cwd: args.repository,
  sandbox: "workspace-write",
});
```

显式集成仍是普通 `agent()`，脚本必须先 await 来源；来源 node id、workspace 和 commit 由
Desktop 冻结配置与 Runtime 提供，不新增作者字段。prompt 只描述合并、冲突处理和整体测试，
不得预测 commit hash、执行 push 或合入主工作区。

## 脚本级人工决策（仅受限草案）

只有真正的业务分叉才用 `decisionGate`；先说明为什么需要人、可选项与影响：

```ts
phase("确认");
const decision = await decisionGate(
  "confirm-scope",
  `计划将修改 ${planned.files} 个文件。是否按此范围继续？`,
  {
    type: "object",
    properties: { approved: { type: "boolean" }, note: { type: "string" } },
    required: ["approved"],
    additionalProperties: false,
  },
);
if (decision.approved !== true) throw new Error(`用户未批准执行范围：${decision.note ?? "无说明"}`);
```

gate  durable-first：先落盘再等待；用户停止 Execution 时等待中的 gate 会被拒绝，
脚本随之收敛。Worker 自己的中途提问走 block/answer/continue，不要为它编排 gate。

## 可观测的长任务

把日志当作 Workflow 的实时状态通道，覆盖每一个用户可能怀疑"是不是卡住了"的间隔：

- `phase()` 之后立即 `log()` 说明本阶段范围；
- 慢速 `agent()` 之前说明它在做什么，而不是等返回后才说；
- 扇出时报告每个任务的开始与完成，完成消息带新事实（数量、结论、选择），不是只有"完成"；
- 汇总前说明有多少可用结果进入汇总。

## 循环与回溯

`phase()` 可以重复进入同一已声明阶段（猜测→分析→再猜测），每次进入是一轮新的阶段
访问。受限草案受护栏限制：`phase()` 切换总数 ≤ 50、`agent()` 总数 ≤ 20，循环必须有
明确收敛条件，不要写无界循环。
