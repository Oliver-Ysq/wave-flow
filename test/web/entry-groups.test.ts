import { expect, test } from "bun:test";
import {
  groupToolEntries,
  toolGroupLabel,
  toolGroupStatus,
  toolGroupTimes,
} from "../../src-tauri/web/src/conversation/entry-groups";
import type {
  LeadBodyEntry,
  LeadThoughtEntry,
  LeadToolEntry,
  LeadToolKind,
} from "../../src-tauri/web/src/types";

/** 构造最小工具条目。 */
function tool(
  entryId: string,
  toolKind: LeadToolKind,
  status: LeadToolEntry["status"] = "completed",
): LeadToolEntry {
  return {
    kind: "tool",
    entryId,
    turnId: "t1",
    seq: Number(entryId.replace(/\D/g, "")) || 0,
    legacy: false,
    callId: `call-${entryId}`,
    source: "engine-mcp",
    name: entryId,
    toolKind,
    target: null,
    paramsSummary: null,
    startedAt: "2026-10-15T08:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-10-15T08:00:02.000Z",
    status,
    output: null,
    outputTruncated: false,
    exitCode: null,
    hasDetail: true,
  };
}

/** 构造最小正文条目。 */
function body(entryId: string): LeadBodyEntry {
  return {
    kind: "body",
    entryId,
    turnId: "t1",
    seq: Number(entryId.replace(/\D/g, "")) || 0,
    legacy: false,
    text: "正文",
    completed: true,
    truncated: false,
    startedAt: "2026-10-15T08:00:00.000Z",
    finishedAt: "2026-10-15T08:00:01.000Z",
  };
}

/** 构造最小思考条目。 */
function thought(entryId: string): LeadThoughtEntry {
  return {
    kind: "thought",
    entryId,
    turnId: "t1",
    seq: Number(entryId.replace(/\D/g, "")) || 0,
    legacy: false,
    text: "思考",
    startedAt: "2026-10-15T08:00:00.000Z",
    finishedAt: "2026-10-15T08:00:01.000Z",
    status: "completed",
    truncated: false,
  };
}

test("连续工具调用折叠为一组，落单工具不包组", () => {
  const items = groupToolEntries([
    tool("e1", "file-read"),
    tool("e2", "search"),
    body("e3"),
    tool("e4", "command"),
  ]);
  expect(items).toHaveLength(3);
  expect(items[0].kind).toBe("tool-group");
  expect(items[1].kind).toBe("body");
  expect(items[2].kind).toBe("tool");
});

test("思考条目打断工具分组", () => {
  const items = groupToolEntries([
    tool("e1", "file-read"),
    thought("e2"),
    tool("e3", "command"),
    tool("e4", "command"),
  ]);
  expect(items.map((item) => item.kind)).toEqual([
    "tool",
    "thought",
    "tool-group",
  ]);
});

test("聚合文案按类别首次出现顺序拼接并标注失败数", () => {
  const label = toolGroupLabel([
    tool("e1", "file-read"),
    tool("e2", "search"),
    tool("e3", "file-read", "failed"),
    tool("e4", "command"),
  ]);
  expect(label).toBe("读取了 2 个文件（1 失败） · 搜索了 1 个模式 · 运行了 1 条命令");
});

test("组状态优先级：running 最高，其次 failed、interrupted、completed", () => {
  expect(
    toolGroupStatus([tool("e1", "mcp", "failed"), tool("e2", "mcp", "running")]),
  ).toBe("running");
  expect(
    toolGroupStatus([
      tool("e1", "mcp", "completed"),
      tool("e2", "mcp", "interrupted"),
      tool("e3", "mcp", "failed"),
    ]),
  ).toBe("failed");
  expect(
    toolGroupStatus([tool("e1", "mcp", "completed"), tool("e2", "mcp", "interrupted")]),
  ).toBe("interrupted");
  expect(toolGroupStatus([tool("e1", "mcp"), tool("e2", "mcp")])).toBe(
    "completed",
  );
});

test("组耗时口径：任一进行中则 finishedAt 为 null，否则取末条结束时间", () => {
  const done = toolGroupTimes([tool("e1", "mcp"), tool("e2", "mcp")]);
  expect(done.startedAt).toBe("2026-10-15T08:00:00.000Z");
  expect(done.finishedAt).toBe("2026-10-15T08:00:02.000Z");
  const running = toolGroupTimes([tool("e1", "mcp"), tool("e2", "mcp", "running")]);
  expect(running.finishedAt).toBeNull();
});
