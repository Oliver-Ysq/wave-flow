# Wave Flow 作者 API 契约

本文件是当前已实现公开契约的唯一依据。不要因为其他 Workflow 运行时存在某个能力就在这里添加它。

## 宿主成果交接边界

Wave Flow 新增宿主边界：主控保留OS写隔离、原生读取与四窄MCP；Worker使用可信原生CLI/Home/权限，不做额外OS文件隔离。read-only/workspace-write表示任务意图，不保证不可越界。整worktree v2授权保存实际tracked与非ignored untracked（排除未跟踪node_modules），不预填paths；独立分支可修改同一文件，必须显式集成。完成后冻结唯一完整ready来源，用户读diff后明确squash合入本机目标分支，不自动合入/push。作者不新增worktree/commit/merge接口，不让Worker自行提交。cwd/prompt/lease不能阻止可信Worker写其他目录，外部影响不由Git证明。

Wave Flow 新增宿主约束：Runtime 的 `finalizeCompleted` 不是作者 API。业务 complete 耐久后，受管写执行器须完成 Git 成果保存与关联，`agent()` 才返回原 JSON；保存错误作为 WorkflowContractError 穿透 parallel/pipeline。原版 resume 可只恢复宿主成果交接，业务 completed 不回退，不创建新 Worker 或假 executionAttempt。Codex与Kimi 2.2.0受管并行写/集成、明确squash合入与桌面收尾已有真实证据，执行仍要求Engine冻结授权和已验证Adapter；不能使用未公开workspace作者字段或把当前两种CLI能力扩展到未知CLI。

## 两种模块形状

### 受信任本地模块（用户选择并预检）

```ts
import { agent, log, parallel, phase, pipeline } from "wave-flow";

export const meta = {
  name: "code-review",
  description: "审查变更并汇总问题。",
  phases: [{ title: "审查" }, { title: "汇总" }],
  inputSchema: { type: "object", properties: { target: { type: "string", minLength: 1 } }, required: ["target"], additionalProperties: false },
  exampleArgs: { target: "src" },
};

interface Args {
  target: string;
}

export default async function run(args: Args) {
  phase("审查");
  // …编排…
}
```

静态规则（加载前校验，违反即拒绝）：

- 值导入只允许来自 `"wave-flow"`；类型导入（`import type`）不受限。不支持动态 `import()`。
- `import` 必须全部位于 `meta` 之前。
- `export const meta` 是 import 之后的第一条语句，且是纯字面量。
- 入口必须是恰好一个参数的函数声明 `export default async function run(args)`。
- 顶层只允许 import、`meta`、类型声明与默认 `run`；不得执行其他顶层语句。

本地来源经桌面选择、预检并确认后执行，历史 `wave-flow run` 产品命令已删除；`run()` 的返回值成为 Run 结果。内容型成果优先由 Agent 写入文件，返回值保持紧凑（路径、格式、摘要）。冻结恢复使用原源码快照，不读取用户后来修改的文件；修改文件或输入须准备新版并确认新的Execution。

### 主控受限草案（`propose_workflow_revision` → 用户审批 → Execution）

```ts
const meta = {
  name: "topic-research",
  description: "并行调研一个主题并汇总结论。",
  phases: [{ title: "计划" }, { title: "调研" }, { title: "汇总" }],
  exampleArgs: { topic: "Agent 技能的演进" },
};

interface Args {
  topic: string;
}

async function run(args: Args) {
  phase("计划");
  // …编排…
}
```

静态规则（编译前校验，违反即拒绝，绝不执行）：

- 不是模块：禁止一切 `import`/`export`，作者 API 由 Runtime 注入。
- 顶层第一条非类型语句必须是 `const meta = { … }` 纯字面量；随后是 `async function run(args)`；
  其余只能是类型声明。
- 可引用的全局只有 `agent`、`phase`、`parallel`、`pipeline`、`log`、`decisionGate`、`JSON`、`Error`
  与脚本内声明的标识符。
- 禁止 class、`this`/`super`、generator、标签语句、`constructor`/`prototype`/`__proto__` 成员访问。
- 护栏上限：`agent()` 总数 20、`phase()` 切换 50、`decisionGate()` 10。

## `meta`

Wave Flow 新增（新本地 Task，已实现）：纯字面量 `inputSchema?: JsonObject`，新本地任务预检必填 `type: "object"`，旧模块直接加载和冻结恢复不追加强制要求。参数 Schema 使用 AJV 校验，不自动填默认，`exampleArgs`不作为校验或批准。

```ts
type WorkflowMeta = {
  name: string;              // kebab-case：/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
  description: string;       // 非空、单行
  phases: { title: string }[]; // 非空、title 唯一且非空
  exampleArgs?: JsonObject;  // 可选，JSON-safe
};
```

## `agent()`

```ts
function agent<T extends JsonObject = JsonObject>(
  prompt: string,
  options: AgentOptions,
): Promise<T | null>;
```

执行一次完整的本机 CLI ACP Worker 会话（Codex 或 Kimi）。直接 `await` 时失败会抛出并把节点标记为
interrupted；在 `parallel()` / `pipeline()` 内失败时该任务结果为 `null`。

```ts
type AgentOptions = {
  id: string;          // 必填；Run 内唯一稳定，1–120 位 [A-Za-z0-9._:/-]
  cli: "codex" | "kimi"; // 必填；当前已验证的 CLI；该 Runtime 必须在设置页验证通过
  label?: string;      // 可选展示名；缺省用 id
  cwd?: string;        // 可选；相对路径必须位于 Workflow 项目目录内
  model?: string;      // 可选；由 Adapter 决定是否支持
  schema?: JsonObject; // 可选；Worker 的 complete 结果按此校验
  sandbox?: "read-only" | "workspace-write"; // 缺省 read-only
  input?: JsonObject;  // 可选显式上游输入；参与 prompt 构造与 replay 指纹
};
```

没有 `danger-full-access`、重试、预算或嵌套 Workflow 字段。`schema` 只接受 JSON-safe
对象；需要 URL 时用 `{ type: "string" }` 并在 prompt 中要求绝对 HTTP(S) 地址，不要依赖
`format` 关键字。

Worker 的完成、阻塞与恢复由 Runtime 注入的 session-private MCP 控制工具处理：prompt
里只写业务任务，不写 shell `wave-flow complete` 之类的上报指令。Worker 中途需要人工
输入时会自行调用 block，用户在 Web 界面回答后由原 Worker 决定是否继续。

## `phase()`

```ts
function phase(title: string): void;
```

切换当前阶段；`title` 必须精确匹配 `meta.phases` 中已声明的标题。不得在 `parallel()`
任务或 `pipeline()` 阶段内调用。同一阶段可以被多次进入（循环/回溯），每次进入是一轮
新的阶段访问。

## `parallel()`

```ts
function parallel<T>(tasks: readonly (() => Promise<T> | T)[]): Promise<Array<T | null>>;
```

所有任务并发启动，结果保持输入顺序；失败任务为 `null`，不取消其他任务。

```ts
const results = await parallel([
  () => agent("审查认证模块。", { id: "review-auth", cli: "codex" }),
  () => agent("审查鉴权模块。", { id: "review-authz", cli: "codex" }),
]);
const findings = results.filter((item) => item !== null);
```

## `pipeline()`

```ts
function pipeline<T>(items: readonly T[], ...stages: ((value: unknown) => unknown | Promise<unknown>)[]): Promise<Array<unknown | null>>;
```

每个 item 独立、串行地经过全部 stage；某个 stage 失败后该 item 跳过后续 stage，最终
结果为 `null`。stage 只接收上一阶段的当前值；`agent()` 需要稳定 `id`，把它编进 item 本身：

```ts
const drafted = await pipeline(
  sections.map((section, index) => ({ id: `draft-${index + 1}`, section })),
  (value) => {
    const item = value as { id: string; section: string };
    return agent(`起草小节：\n${item.section}`, { id: item.id, cli: "codex" });
  },
);
```

注意：worktree/commit/集成来源不是作者 API。Desktop 对固定写节点冻结用户 Git 授权后，
独立受管工作区可并行修改同一文件；相同分组顺序复用。没有整工作区授权或Worker Control验证时写节点 fail
closed。作者仍须先 await 来源，再调用普通集成 Agent；不得在脚本里预测 commit hash。

## `log()`

```ts
function log(message: string): void;
```

写入耐久日志事实，供 CLI 与 Web 实时展示。在每个可能较慢的操作之前调用；只发新信息。

## `decisionGate()`（仅受限草案）

```ts
function decisionGate(id: string, question: string, answerSchema?: JsonObject): Promise<JsonObject>;
// 或对象形式：decisionGate({ id, question, answerSchema })
```

先耐久落盘再阻塞等待用户在界面提交 JSON 答案；`answerSchema` 提供时先校验再交付。
`id` 在同一 Run 内唯一（1–120 位 `[A-Za-z0-9._:/-]`）。只用于没有人类决定就无法安全
继续的真正业务分叉；脚本普通错误自行处理，不要升级为用户表单。

## 结果与返回

`run()` 的返回值必须是 JSON-safe（受限草案由桥按 JSON 传递）。`agent()` 的结果来自
Worker 的受控 `complete`，总是 JSON 对象；内容型成果让 Worker 写入文件、脚本只传递
路径与摘要。
