import type { ExecutionConfigSnapshot, WorkerAssignment } from "../harness/types";
import type { CliRuntimeView, RuntimeCli } from "../runtimes/types";
import type { ExtractedAgentWorker } from "../workflow/restricted/extract-agents";

/**
 * 分配卡的纯函数助手：把已枚举 Worker、已验证 Runtime 池与用户选择组装成可冻结的
 * ExecutionConfigSnapshot，并在创建 Execution 前做严格复核。所有函数都不触碰磁盘、
 * Registry 或 Harness 会话，Engine action 负责取数后调用。
 */

/** defaultAssignment 的占位 agentId；它不是真实节点，只表示未枚举 Worker 的兜底分配。 */
export const DEFAULT_ASSIGNMENT_ID = "*";

/** 单个 Worker 指派；cli/adapter 字段必须来自同一个已验证 Runtime，调用方不得拼接。 */
export function assignmentForRuntime(agentId: string, runtime: CliRuntimeView, source: WorkerAssignment["source"]): WorkerAssignment {
  return { agentId, cli: runtime.cli, model: "cli-default", source, runtimeId: runtime.runtimeId, adapterId: runtime.verifiedAdapter.adapterId, adapterVersion: runtime.verifiedAdapter.adapterVersion };
}

/** “全部用主控 CLI”：每个枚举 Worker 与兜底都指向主控 Runtime。 */
export function buildHarnessCliAssignments(workers: readonly ExtractedAgentWorker[], harnessRuntime: CliRuntimeView): { readonly assignments: readonly WorkerAssignment[]; readonly defaultAssignment: WorkerAssignment } {
  return { assignments: workers.map((worker) => assignmentForRuntime(worker.id, harnessRuntime, "harness-cli")), defaultAssignment: assignmentForRuntime(DEFAULT_ASSIGNMENT_ID, harnessRuntime, "harness-cli") };
}

/** 按 cli 解析唯一 Worker Runtime：用户偏好优先，恰好一个候选时取之，其余情况无法诚实选择。 */
export function runtimeForCli(cli: RuntimeCli, pool: readonly CliRuntimeView[], selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>): CliRuntimeView | null {
  const candidates = pool.filter((runtime) => runtime.cli === cli);
  const preferred = selectedByCli[cli] ? candidates.find((runtime) => runtime.runtimeId === selectedByCli[cli]) : undefined;
  if (preferred) return preferred;
  if (candidates.length === 1) return candidates[0]!;
  return null;
}

/**
 * Engine 侧随机分配：相邻 Worker 尽量轮换池内不同 CLI，runtime 按用户偏好或唯一候选
 * 确定。仅首次进入分配卡或用户显式“重新随机”时由 Engine 重新生成；已冻结快照永不重摇。
 */
export function buildRandomAssignments(workers: readonly ExtractedAgentWorker[], pool: readonly CliRuntimeView[], selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>, fallbackRuntime: CliRuntimeView): { readonly assignments: readonly WorkerAssignment[]; readonly defaultAssignment: WorkerAssignment } {
  const clis = [...new Set(pool.map((runtime) => runtime.cli))];
  if (clis.length === 0) throw new Error("没有已验证的 Worker 执行底座，无法随机分配。 ");
  // 随机起点避免每次首节点都落在同一 CLI；轮换本身确定，便于审计与复核。
  const offset = crypto.getRandomValues(new Uint32Array(1))[0]! % clis.length;
  const assignments: WorkerAssignment[] = [];
  for (let index = 0; index < workers.length; index += 1) {
    const cli = clis[(index + offset) % clis.length]!;
    const runtime = runtimeForCli(cli, pool, selectedByCli);
    if (!runtime) throw new Error(`本机 ${cli} CLI 存在多个已验证候选且未设偏好，无法随机分配。 `);
    assignments.push(assignmentForRuntime(workers[index]!.id, runtime, "random"));
  }
  return { assignments, defaultAssignment: assignmentForRuntime(DEFAULT_ASSIGNMENT_ID, fallbackRuntime, "random") };
}

/** 主控规则解析回合的结构化 prompt；要求主控只回复一个 ```json 围栏对象。 */
export function buildRulePrompt(ruleText: string, workers: readonly ExtractedAgentWorker[], pool: readonly CliRuntimeView[]): string {
  const workerLines = workers.map((worker) => `- ${worker.id}${worker.label && worker.label !== worker.id ? `（${worker.label}）` : ""}`).join("\n");
  const cliLines = [...new Set(pool.map((runtime) => runtime.cli))].map((cli) => `- ${cli}`).join("\n");
  return [
    "这是一个结构化解析请求，不是业务任务。请不要调用任何工具，只回复一个 ```json 围栏代码块，不要输出其他文字。",
    "",
    "请把下面的自然语言分配规则解析为 Worker CLI 指派。",
    "",
    "可分配的 Worker id（只能使用这些 id，或用 \"*\" 表示全部）：",
    workerLines || "-（本次脚本没有可枚举的字面量 Worker）",
    "",
    "可使用的 CLI（只能使用这些值）：",
    cliLines,
    "",
    "回复格式严格为：",
    "```json",
    "{ \"assignments\": [{ \"agentId\": \"worker-id\", \"cli\": \"codex\" }] }",
    "```",
    "",
    "规则原文：",
    ruleText,
  ].join("\n");
}

/** 规则解析失败时抛出；调用方（Engine）一律把它收敛为 degraded，绝不静默猜测。 */
export function parseRuleReply(replyText: string, workers: readonly ExtractedAgentWorker[], pool: readonly CliRuntimeView[], selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>): readonly WorkerAssignment[] {
  const match = /```json\s*([\s\S]*?)```/.exec(replyText);
  if (!match) throw new Error("主控回复缺少 ```json 围栏。 ");
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]!); } catch { throw new Error("主控回复的 JSON 无法解析。 "); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { assignments?: unknown }).assignments)) throw new Error("主控回复缺少 assignments 数组。 ");
  const enumerated = new Set(workers.map((worker) => worker.id));
  const result = new Map<string, WorkerAssignment>();
  for (const item of (parsed as { assignments: unknown[] }).assignments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("主控回复的指派条目无效。 ");
    const { agentId, cli } = item as { agentId?: unknown; cli?: unknown };
    if (typeof agentId !== "string" || (agentId !== "*" && !enumerated.has(agentId))) throw new Error(`主控回复包含未枚举的 Worker id：${String(agentId)}`);
    if (cli !== "codex" && cli !== "kimi") throw new Error(`主控回复包含池外 CLI：${String(cli)}`);
    const runtime = runtimeForCli(cli, pool, selectedByCli);
    if (!runtime) throw new Error(`本机 ${cli} CLI 没有可唯一确定的已验证候选。 `);
    for (const id of agentId === "*" ? [...enumerated] : [agentId]) result.set(id, assignmentForRuntime(id, runtime, "rule"));
  }
  return [...result.values()];
}

/** 组装冻结快照；createdAt 由 Engine 在创建时生成。 */
export function buildExecutionConfig(input: { readonly assignments: readonly WorkerAssignment[]; readonly defaultAssignment: WorkerAssignment; readonly fallbackRuntimeId: string; readonly ruleText: string | null; readonly ruleDegraded: boolean }): ExecutionConfigSnapshot {
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: input.fallbackRuntimeId, ruleText: input.ruleText, ruleDegraded: input.ruleDegraded, defaultAssignment: input.defaultAssignment, assignments: input.assignments };
}

/**
 * executions.create 的严格复核：快照每个 runtimeId 必须存在且 verified，cli 与
 * adapter 必须与 Registry 记录一致，assignments 的 agentId 必须命中静态枚举，
 * model 只允许 cli-default。任何不符都拒绝创建——分配卡是唯一诚实来源。
 */
export function validateExecutionConfig(value: unknown, workers: readonly ExtractedAgentWorker[], verified: readonly CliRuntimeView[]): ExecutionConfigSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("执行配置快照必须是对象。 ");
  const config = value as Record<string, unknown>;
  if (config.version !== 1) throw new Error("执行配置快照版本不受支持。 ");
  if (typeof config.fallbackRuntimeId !== "string" || !config.fallbackRuntimeId.trim()) throw new Error("执行配置快照缺少回退 Runtime。 ");
  if (config.ruleText !== null && typeof config.ruleText !== "string") throw new Error("执行配置快照 ruleText 无效。 ");
  if (config.ruleDegraded !== true && config.ruleDegraded !== false) throw new Error("执行配置快照 ruleDegraded 无效。 ");
  if (!Array.isArray(config.assignments)) throw new Error("执行配置快照 assignments 无效。 ");
  const byId = new Map(verified.map((runtime) => [runtime.runtimeId, runtime]));
  const checkAssignment = (item: unknown, allowDefault: boolean): WorkerAssignment => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("执行配置快照包含无效指派。 ");
    const assignment = item as Record<string, unknown>;
    if (typeof assignment.agentId !== "string" || !assignment.agentId.trim()) throw new Error("执行配置快照指派缺少 agentId。 ");
    if (!allowDefault && assignment.agentId === DEFAULT_ASSIGNMENT_ID) throw new Error("兜底指派不能出现在 assignments 列表中。 ");
    if (assignment.model !== "cli-default") throw new Error("本期只允许 cli-default 模型分配；模型覆盖尚未验证。 ");
    if (assignment.source !== "harness-cli" && assignment.source !== "random" && assignment.source !== "rule" && assignment.source !== "literal-cli") throw new Error("执行配置快照指派来源无效。 ");
    if (typeof assignment.runtimeId !== "string") throw new Error("执行配置快照指派缺少 runtimeId。 ");
    const runtime = byId.get(assignment.runtimeId);
    if (!runtime) throw new Error(`执行配置快照引用了不存在或未验证的 Runtime：${assignment.runtimeId}。 `);
    if (assignment.cli !== runtime.cli) throw new Error("执行配置快照指派的 cli 与 Runtime 记录不一致。 ");
    if (assignment.adapterId !== runtime.verifiedAdapter.adapterId || assignment.adapterVersion !== runtime.verifiedAdapter.adapterVersion) throw new Error("执行配置快照指派的 adapter 与 Runtime 记录不一致。 ");
    return assignment as unknown as WorkerAssignment;
  };
  const defaultAssignment = checkAssignment(config.defaultAssignment, true);
  const enumerated = new Set(workers.map((worker) => worker.id));
  const seen = new Set<string>();
  const assignments = (config.assignments as unknown[]).map((item) => {
    const assignment = checkAssignment(item, false);
    if (!enumerated.has(assignment.agentId)) throw new Error(`执行配置快照指派了未枚举的 Worker id：${assignment.agentId}。 `);
    if (seen.has(assignment.agentId)) throw new Error(`执行配置快照指派重复：${assignment.agentId}。 `);
    seen.add(assignment.agentId);
    return assignment;
  });
  if (!byId.has(config.fallbackRuntimeId)) throw new Error("执行配置快照的回退 Runtime 不存在或未验证。 ");
  return { version: 1, createdAt: typeof config.createdAt === "string" ? config.createdAt : new Date().toISOString(), fallbackRuntimeId: config.fallbackRuntimeId, ruleText: (config.ruleText as string | null) ?? null, ruleDegraded: config.ruleDegraded, defaultAssignment, assignments };
}
