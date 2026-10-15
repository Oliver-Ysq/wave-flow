import { expect, test } from "bun:test";
import {
  acceptEnvelope,
  applyHarnessEventToSnapshot,
  composeConversationTurns,
  createStreamTracker,
  turnNeedsAssistantFallback,
} from "../../src-tauri/web/src/conversation/harness-event-merge";
import type {
  EngineEventEnvelope,
  HarnessBodyEntry,
  HarnessSnapshot,
  HarnessThoughtEntry,
  HarnessToolEntry,
} from "../../src-tauri/web/src/types";

/** 构造最小可用 Harness 快照；测试只关心 messages 与 conversationEntries。 */
function makeSnapshot(
  overrides: Partial<HarnessSnapshot> = {},
): HarnessSnapshot {
  return {
    harnessRunId: "h1",
    projectId: "p1",
    cwd: "/tmp/project",
    status: "running",
    diagnostic: null,
    completedAt: null,
    createdAt: "2026-10-15T08:00:00Z",
    messages: [],
    toolActivitiesByMessageId: {},
    conversationEntries: [],
    workflowRevisions: [],
    executions: [],
    decisions: [],
    ...overrides,
  };
}

/** 构造正文条目。 */
function makeBody(overrides: Partial<HarnessBodyEntry> = {}): HarnessBodyEntry {
  return {
    entryId: "b1",
    turnId: "u1",
    seq: 1,
    legacy: false,
    kind: "body",
    text: "",
    completed: false,
    truncated: false,
    startedAt: "2026-10-15T08:00:01Z",
    finishedAt: null,
    ...overrides,
  };
}

/** 构造工具条目。 */
function makeTool(overrides: Partial<HarnessToolEntry> = {}): HarnessToolEntry {
  return {
    entryId: "t1",
    turnId: "u1",
    seq: 2,
    legacy: false,
    kind: "tool",
    callId: "c1",
    source: "acp",
    name: "run_command",
    toolKind: "command",
    target: "bun test",
    paramsSummary: null,
    startedAt: "2026-10-15T08:00:01Z",
    finishedAt: null,
    status: "running",
    output: null,
    outputTruncated: false,
    exitCode: null,
    hasDetail: true,
    ...overrides,
  };
}

/** 构造思考条目。 */
function makeThought(
  overrides: Partial<HarnessThoughtEntry> = {},
): HarnessThoughtEntry {
  return {
    entryId: "th1",
    turnId: "u1",
    seq: 3,
    legacy: false,
    kind: "thought",
    text: "",
    startedAt: "2026-10-15T08:00:01Z",
    finishedAt: null,
    status: "running",
    truncated: false,
    ...overrides,
  };
}

/** 构造 Engine 事件包裹。 */
function makeEnvelope(
  generation: number,
  seq: number,
  event: EngineEventEnvelope["frame"]["event"],
): EngineEventEnvelope {
  return {
    generation,
    frame: {
      type: "event",
      protocolVersion: 1,
      stream: "harness",
      harnessRunId: "h1",
      seq,
      event,
    },
  };
}

test("entry_started 按到达顺序追加且对重复 entryId 幂等", () => {
  const tool = makeTool({ seq: 2 });
  const body = makeBody({ seq: 1 });
  let snapshot = makeSnapshot();
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_started",
    entry: tool,
  });
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_started",
    entry: body,
  });
  // 事件按 Journal 顺序到达，插入保持到达顺序；回合内排序由 composeConversationTurns 负责。
  expect(snapshot.conversationEntries.map((entry) => entry.entryId)).toEqual([
    "t1",
    "b1",
  ]);
  const again = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_started",
    entry: makeBody({ seq: 1, text: "不应覆盖" }),
  });
  expect(again).toBe(snapshot);
  expect(again.conversationEntries).toHaveLength(2);
});

test("entry_appended 对 body 追加文本并对 truncated 取或", () => {
  let snapshot = makeSnapshot({
    conversationEntries: [makeBody({ text: "你好" })],
  });
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_appended",
    entryId: "b1",
    text: "，世界",
    truncated: false,
  });
  const entry = snapshot.conversationEntries[0] as HarnessBodyEntry;
  expect(entry.text).toBe("你好，世界");
  expect(entry.truncated).toBe(false);
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_appended",
    entryId: "b1",
    text: "！",
    truncated: true,
  });
  const updated = snapshot.conversationEntries[0] as HarnessBodyEntry;
  expect(updated.text).toBe("你好，世界！");
  expect(updated.truncated).toBe(true);
  // 已截断标记不可被后续未截断增量清除。
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_appended",
    entryId: "b1",
    text: "。",
    truncated: false,
  });
  expect((snapshot.conversationEntries[0] as HarnessBodyEntry).truncated).toBe(
    true,
  );
  // 未知 entryId 不产生任何变化。
  const untouched = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_appended",
    entryId: "missing",
    text: "x",
    truncated: true,
  });
  expect(untouched).toBe(snapshot);
});

test("entry_appended 对 tool 以 null 起算追加输出并对 outputTruncated 取或", () => {
  let snapshot = makeSnapshot({ conversationEntries: [makeTool()] });
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_appended",
    entryId: "t1",
    text: "line1\n",
    truncated: true,
  });
  let entry = snapshot.conversationEntries[0] as HarnessToolEntry;
  expect(entry.output).toBe("line1\n");
  expect(entry.outputTruncated).toBe(true);
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_appended",
    entryId: "t1",
    text: "line2\n",
    truncated: false,
  });
  entry = snapshot.conversationEntries[0] as HarnessToolEntry;
  expect(entry.output).toBe("line1\nline2\n");
  expect(entry.outputTruncated).toBe(true);
});

test("entry_finished 按 entryId 整体替换条目", () => {
  const started = makeBody({ text: "部分", completed: false });
  let snapshot = makeSnapshot({ conversationEntries: [started] });
  const finished = makeBody({
    text: "完整回答",
    completed: true,
    finishedAt: "2026-10-15T08:00:05Z",
  });
  snapshot = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_finished",
    entry: finished,
  });
  expect(snapshot.conversationEntries[0]).toEqual(finished);
  // 未知 entryId 的 finished 不插入新条目。
  const unknown = applyHarnessEventToSnapshot(snapshot, {
    type: "entry_finished",
    entry: makeBody({ entryId: "ghost" }),
  });
  expect(unknown).toBe(snapshot);
});

test("turn_finished/turn_interrupted/execution_changed 原样返回快照", () => {
  const snapshot = makeSnapshot({ conversationEntries: [makeBody()] });
  expect(
    applyHarnessEventToSnapshot(snapshot, {
      type: "turn_finished",
      messageId: "a1",
      text: "完整回答",
    }),
  ).toBe(snapshot);
  expect(
    applyHarnessEventToSnapshot(snapshot, {
      type: "turn_interrupted",
      diagnostic: "用户停止",
    }),
  ).toBe(snapshot);
  expect(
    applyHarnessEventToSnapshot(snapshot, {
      type: "execution_changed",
      executionId: "e1",
    }),
  ).toBe(snapshot);
});

test("acceptEnvelope：generation 变化 resync、重复 seq skip、连续 apply、跳帧 resync", () => {
  const tracker = createStreamTracker();
  const first = makeEnvelope(1, 1, { type: "turn_interrupted", diagnostic: "" });
  expect(acceptEnvelope(tracker, first)).toBe("resync");
  expect(tracker.generation).toBe(1);
  expect(tracker.lastSeq).toBe(1);
  // 重复与乱序旧帧一律 skip。
  expect(acceptEnvelope(tracker, first)).toBe("skip");
  // 严格连续帧 apply 并前进。
  expect(acceptEnvelope(tracker, makeEnvelope(1, 2, first.frame.event))).toBe(
    "apply",
  );
  expect(tracker.lastSeq).toBe(2);
  // 跳帧 resync，tracker 对齐到该帧以便重读后继续增量。
  expect(acceptEnvelope(tracker, makeEnvelope(1, 5, first.frame.event))).toBe(
    "resync",
  );
  expect(tracker.lastSeq).toBe(5);
  expect(acceptEnvelope(tracker, makeEnvelope(1, 6, first.frame.event))).toBe(
    "apply",
  );
  // Engine 重启：generation 变化重新计数，仍是 resync。
  expect(acceptEnvelope(tracker, makeEnvelope(2, 1, first.frame.event))).toBe(
    "resync",
  );
  expect(tracker.generation).toBe(2);
  expect(tracker.lastSeq).toBe(1);
  expect(acceptEnvelope(tracker, makeEnvelope(2, 2, first.frame.event))).toBe(
    "apply",
  );
});

test("composeConversationTurns：正文条目覆盖 assistant 回落渲染", () => {
  const snapshot = makeSnapshot({
    messages: [
      { id: "u1", role: "user", text: "任务", createdAt: "2026-10-15T08:00:00Z" },
      { id: "a1", role: "assistant", text: "完整回答", createdAt: "2026-10-15T08:00:06Z" },
    ],
    conversationEntries: [
      makeBody({ text: "完整回答", completed: true, finishedAt: "2026-10-15T08:00:05Z" }),
      makeTool({ seq: 0 }),
    ],
  });
  const turns = composeConversationTurns(snapshot);
  expect(turns).toHaveLength(1);
  expect(turns[0].user.id).toBe("u1");
  expect(turns[0].assistant?.id).toBe("a1");
  // 条目按 seq 升序，与写入顺序无关。
  expect(turns[0].entries.map((entry) => entry.entryId)).toEqual(["t1", "b1"]);
  // 有正文条目时不回落渲染 assistant 消息。
  expect(turnNeedsAssistantFallback(turns[0])).toBe(false);
});

test("composeConversationTurns：legacy 回合无正文条目时回落 assistant 并保留工具条目位置", () => {
  const snapshot = makeSnapshot({
    messages: [
      { id: "u1", role: "user", text: "任务", createdAt: "2026-10-15T08:00:00Z" },
      { id: "a1", role: "assistant", text: "旧回答", createdAt: "2026-10-15T08:00:06Z" },
    ],
    conversationEntries: [
      makeTool({ legacy: true, hasDetail: false, output: null }),
    ],
  });
  const turns = composeConversationTurns(snapshot);
  expect(turns).toHaveLength(1);
  expect(turnNeedsAssistantFallback(turns[0])).toBe(true);
  expect(turns[0].entries).toHaveLength(1);
  expect(turns[0].entries[0].kind).toBe("tool");
});

test("composeConversationTurns：中断回合保留 completed=false 的正文残留且无 assistant", () => {
  const snapshot = makeSnapshot({
    status: "interrupted",
    diagnostic: "用户停止",
    messages: [
      { id: "u1", role: "user", text: "任务", createdAt: "2026-10-15T08:00:00Z" },
    ],
    conversationEntries: [
      makeBody({ text: "未完成的半条回答", completed: false, finishedAt: "2026-10-15T08:00:03Z" }),
    ],
  });
  const turns = composeConversationTurns(snapshot);
  expect(turns).toHaveLength(1);
  expect(turns[0].assistant).toBeNull();
  expect(turns[0].entries).toHaveLength(1);
  const body = turns[0].entries[0] as HarnessBodyEntry;
  expect(body.kind).toBe("body");
  expect(body.completed).toBe(false);
  expect(turnNeedsAssistantFallback(turns[0])).toBe(false);
});

test("composeConversationTurns：assistant 归属最近的用户消息，多回合顺序保持", () => {
  const snapshot = makeSnapshot({
    messages: [
      { id: "u1", role: "user", text: "一", createdAt: "2026-10-15T08:00:00Z" },
      { id: "a1", role: "assistant", text: "答一", createdAt: "2026-10-15T08:00:05Z" },
      { id: "u2", role: "user", text: "二", createdAt: "2026-10-15T08:01:00Z" },
    ],
    conversationEntries: [makeThought({ turnId: "u2" })],
  });
  const turns = composeConversationTurns(snapshot);
  expect(turns.map((turn) => turn.turnId)).toEqual(["u1", "u2"]);
  expect(turns[0].assistant?.id).toBe("a1");
  expect(turns[1].assistant).toBeNull();
  expect(turns[1].entries.map((entry) => entry.entryId)).toEqual(["th1"]);
  expect(turns[0].entries).toHaveLength(0);
});
