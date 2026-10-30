import { expect, test } from "bun:test";
import { AcpContextTracker } from "../../src/adapters/acp-context";
import type * as acp from "@agentclientprotocol/sdk";

const text = (value: string): acp.ContentBlock => ({ type: "text", text: value });

/**
 * compaction_update 是 upsert：同一 compactionId 的后续通知就地 patch 该实体，
 * 字段省略保持原值、null 清空、具体值整体替换。实现必须按这个语义消费，
 * 否则 Agent 的压缩状态机会在客户端侧错乱。
 */
test("compaction_update 按 compactionId upsert，省略保持、null 清空、具体值替换", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" });
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress", summary: [text("第一版")] });
  expect(tracker.compactions).toHaveLength(1);
  expect(tracker.compactions[0].summary).toEqual([text("第一版")]);

  // 省略 summary：保持上一版摘要不变。
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
  expect(tracker.compactions[0].status).toBe("completed");
  expect(tracker.compactions[0].summary).toEqual([text("第一版")]);

  // 具体值：整体替换。
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed", summary: [text("第二版")] });
  expect(tracker.compactions[0].summary).toEqual([text("第二版")]);

  // null 与空数组都清空。
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed", summary: null });
  expect(tracker.compactions[0].summary).toEqual([]);
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed", summary: [text("第三版")] });
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed", summary: [] });
  expect(tracker.compactions[0].summary).toEqual([]);
});

/**
 * 摘要分片按接收顺序追加；具体 summary 是权威替换，之后的分片追加到替换结果上。
 * 首次见到的 compactionId 会创建一个进行中的压缩。
 */
test("compaction_summary_chunk 按接收顺序追加，具体 summary 之后的分片追加到替换结果", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: text("甲") });
  expect(tracker.compactions).toHaveLength(1);
  expect(tracker.compactions[0].status).toBe("in_progress");
  tracker.apply({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: text("乙") });
  expect(tracker.compactions[0].summary).toEqual([text("甲"), text("乙")]);

  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed", summary: [text("替换")] });
  expect(tracker.compactions[0].summary).toEqual([text("替换")]);
  tracker.apply({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: text("丙") });
  expect(tracker.compactions[0].summary).toEqual([text("替换"), text("丙")]);
});

/**
 * usage_update 无需客户端能力声明，used 是当前上下文占用、size 是窗口总量。
 * 个别实现在会话早期把窗口大小写成占位值，此时 used 可能大于 size，
 * 据此计算的百分比是假的，必须判定为不可用而不是照单全收。
 */
test("usage_update 的 used/size 只有在 used 不超过 size 时才可用于阈值判断", () => {
  const tracker = new AcpContextTracker();
  expect(tracker.usage).toEqual({ usage: null, reliable: false, afterCompaction: false });
  tracker.apply({ sessionUpdate: "usage_update", used: 1200, size: 8000 });
  expect(tracker.usage.usage).toEqual({ used: 1200, size: 8000 });
  expect(tracker.usage.reliable).toBe(true);

  tracker.apply({ sessionUpdate: "usage_update", used: 9000, size: 8000 });
  expect(tracker.usage.reliable).toBe(false);
});

/** 回合边界只清空回合级标记；压缩实体与 usage 的历史必须保留，否则诊断会丢归因。 */
test("回合边界清空回合级标记但保留压缩历史与占用快照", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "usage_update", used: 100, size: 1000 });
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
  expect(tracker.compactedThisTurn).toBe(true);

  tracker.beginTurn();
  expect(tracker.compactedThisTurn).toBe(false);
  expect(tracker.compactions).toHaveLength(1);
  expect(tracker.usage.usage).toEqual({ used: 100, size: 1000 });
});

/** 与上下文无关的 session update 不得污染跟踪器。 */
test("非上下文事件不产生压缩事实或占用快照", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "agent_message_chunk", content: text("无关") });
  tracker.apply({ sessionUpdate: "plan", entries: [] });
  expect(tracker.compactions).toHaveLength(0);
  expect(tracker.usage.usage).toBeNull();
});

/**
 * 真实 Codex 在压缩完成后立刻把占用降到压缩后的大小（实测 16747 → 11909）。
 * 这份快照必须被标记为"测于压缩之后"，否则下游会把占用下降误读成额度回升。
 */
test("压缩完成后的占用快照被标记为压缩后测量", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "usage_update", used: 16747, size: 30400 });
  expect(tracker.usage.afterCompaction).toBe(false);
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
  tracker.apply({ sessionUpdate: "usage_update", used: 11909, size: 30400 });
  expect(tracker.usage.usage).toEqual({ used: 11909, size: 30400 });
  expect(tracker.usage.afterCompaction).toBe(true);
  expect(tracker.usage.reliable).toBe(true);
});

/**
 * 压缩后标记只在所属回合内有效：很久之后的快照继续被标成"压缩后测量"，
 * 会被读成"刚发生过压缩"。
 */
test("回合边界清零压缩后标记，避免误报刚发生过压缩", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
  tracker.apply({ sessionUpdate: "usage_update", used: 11909, size: 30400 });
  expect(tracker.usage.afterCompaction).toBe(true);
  tracker.beginTurn();
  expect(tracker.usage.afterCompaction).toBe(false);
  expect(tracker.usage.usage).toEqual({ used: 11909, size: 30400 });
});

/**
 * 压缩完成不会让已有快照的测量位置变新：真实 Codex 的到达顺序并不保证压缩事件
 * 晚于最后一次 usage_update（实测出现过 usage → compaction_update）。
 * 此时把旧快照标成"压缩后测量"，会把压缩前的大数字读成压缩后的结果。
 */
test("压缩完成不追认压缩前采到的占用快照；只有之后到达的快照才算压缩后测量", () => {
  const tracker = new AcpContextTracker();
  tracker.apply({ sessionUpdate: "usage_update", used: 16747, size: 30400 });
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
  // 仍是压缩前那份快照：不能声称它测于压缩之后。
  expect(tracker.usage.usage).toEqual({ used: 16747, size: 30400 });
  expect(tracker.usage.afterCompaction).toBe(false);

  // 压缩完成后到达的新快照才建立这个断言。
  tracker.apply({ sessionUpdate: "usage_update", used: 11909, size: 30400 });
  expect(tracker.usage.afterCompaction).toBe(true);

  // 非 completed 的压缩不改变任何快照的测量位置。
  tracker.beginTurn();
  tracker.apply({ sessionUpdate: "usage_update", used: 900, size: 30400 });
  tracker.apply({ sessionUpdate: "compaction_update", compactionId: "c2", status: "failed", error: "断线" });
  expect(tracker.usage.usage).toEqual({ used: 900, size: 30400 });
  expect(tracker.usage.afterCompaction).toBe(false);
});
