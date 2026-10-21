import type { ExecutionConfigSnapshot, WorkerAssignment } from "../harness/types";
import type { CliRuntimeView } from "../runtimes/types";
import type { ExtractedAgentWorker } from "../workflow/restricted/extract-agents";
import { validateExecutionWorkspaces } from "../workspace/execution-workspaces";
import { adapterById } from "../runtimes/adapter-catalog";

/**
 * 分配卡的纯函数助手：把已枚举 Worker、已验证 Runtime 池与用户选择组装成可冻结的
 * ExecutionConfigSnapshot，并在创建 Execution 前做严格复核。所有函数都不触碰磁盘、
 * Registry 或 Harness 会话，Engine action 负责取数后调用。
 */

/** defaultAssignment 的占位 agentId；它不是真实节点，只表示未枚举 Worker 的兜底分配。 */
export const DEFAULT_ASSIGNMENT_ID = "*";


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
    if (assignment.source !== "harness-cli" && assignment.source !== "user" && assignment.source !== "random" && assignment.source !== "rule" && assignment.source !== "literal-cli") throw new Error("执行配置快照指派来源无效。 ");
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
  const workspaces = config.workspaces === undefined ? undefined : validateExecutionWorkspaces(config.workspaces);
  if (workspaces) for (const node of workspaces.authorization.nodes) {
    const assignment = assignments.find(item => item.agentId === node.nodeId) ?? defaultAssignment;
    if (!adapterById(assignment.adapterId)?.capabilities.workerControlMcp) throw new Error("所选Adapter尚未完成Worker私有完成协议验证；请重新选择CLI。");
  }
  return { version: 1, createdAt: typeof config.createdAt === "string" ? config.createdAt : new Date().toISOString(), fallbackRuntimeId: config.fallbackRuntimeId, ruleText: (config.ruleText as string | null) ?? null, ruleDegraded: config.ruleDegraded, defaultAssignment, assignments, ...(workspaces ? { workspaces } : {}) };
}
