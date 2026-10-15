import type {
  HarnessConversationEntry,
  HarnessConversationEntryStatus,
  HarnessToolEntry,
  HarnessToolKind,
} from "../types";

/**
 * 连续工具调用的聚合组：渲染为一行摘要（如"读取了 2 个文件 · 运行了 1 条命令"），
 * 展开后逐条展示组内工具。kind 固定为 "tool-group"，用于渲染分派。
 */
export type HarnessToolGroup = {
  /** 渲染分派标识。 */
  kind: "tool-group";
  /** 组内工具条目，按 seq 升序，长度 ≥ 2。 */
  entries: HarnessToolEntry[];
};

/** 回合渲染单元：原始条目或连续工具聚合组。 */
export type ConversationRenderItem = HarnessConversationEntry | HarnessToolGroup;

/**
 * 把回合条目中的连续工具调用折叠为聚合组。
 * body / thought 条目会打断分组；落单的工具条目不包组，原样返回。
 * legacy 条目同样参与分组（组内展开时各自显示"历史记录未保存"）。
 */
export function groupToolEntries(
  entries: HarnessConversationEntry[],
): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  let pending: HarnessToolEntry[] = [];
  const flush = () => {
    if (pending.length >= 2) {
      items.push({ kind: "tool-group", entries: pending });
    } else {
      items.push(...pending);
    }
    pending = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") {
      pending.push(entry);
    } else {
      flush();
      items.push(entry);
    }
  }
  flush();
  return items;
}

/** 各工具分类的中文动作文案；计数 N 由调用方填入。 */
const KIND_LABELS: Record<HarnessToolKind, (count: number) => string> = {
  "file-read": (count) => `读取了 ${count} 个文件`,
  "file-write": (count) => `写入了 ${count} 个文件`,
  command: (count) => `运行了 ${count} 条命令`,
  search: (count) => `搜索了 ${count} 个模式`,
  mcp: (count) => `调用了 ${count} 个 MCP 工具`,
  unknown: (count) => `执行了 ${count} 个操作`,
};

/**
 * 聚合组摘要文案：按 toolKind 首次出现顺序拼接计数，
 * 某类含失败条目时在该类段落后追加"（N 失败）"。
 */
export function toolGroupLabel(entries: HarnessToolEntry[]): string {
  const order: HarnessToolKind[] = [];
  const counts = new Map<HarnessToolKind, number>();
  const failures = new Map<HarnessToolKind, number>();
  for (const entry of entries) {
    if (!counts.has(entry.toolKind)) order.push(entry.toolKind);
    counts.set(entry.toolKind, (counts.get(entry.toolKind) ?? 0) + 1);
    if (entry.status === "failed") {
      failures.set(entry.toolKind, (failures.get(entry.toolKind) ?? 0) + 1);
    }
  }
  return order
    .map((kind) => {
      const label = KIND_LABELS[kind](counts.get(kind) ?? 0);
      const failed = failures.get(kind) ?? 0;
      return failed > 0 ? `${label}（${failed} 失败）` : label;
    })
    .join(" · ");
}

/**
 * 聚合组整体状态：任一进行中优先显示 running；其次失败、中断；
 * 全部完成才是 completed。只用于摘要行徽标，不改变任何条目自身状态。
 */
export function toolGroupStatus(
  entries: HarnessToolEntry[],
): HarnessConversationEntryStatus {
  let failed = false;
  let interrupted = false;
  for (const entry of entries) {
    if (entry.status === "running") return "running";
    if (entry.status === "failed") failed = true;
    if (entry.status === "interrupted") interrupted = true;
  }
  if (failed) return "failed";
  if (interrupted) return "interrupted";
  return "completed";
}

/**
 * 聚合组耗时口径：首条 startedAt 到末条 finishedAt；
 * 任一条目仍在进行时 finishedAt 为 null，调用方据此显示"进行中"。
 */
export function toolGroupTimes(entries: HarnessToolEntry[]): {
  startedAt: string;
  finishedAt: string | null;
} {
  const startedAt = entries[0]?.startedAt ?? "";
  const last = entries[entries.length - 1];
  const finishedAt = entries.every((entry) => entry.finishedAt !== null)
    ? (last?.finishedAt ?? null)
    : null;
  return { startedAt, finishedAt };
}
