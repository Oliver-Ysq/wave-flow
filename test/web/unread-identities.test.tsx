import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LeadSnapshot } from "../../src-tauri/web/src/types";
import {
  UnreadTracker,
  parseReadIdentities,
  unreadIdentities,
} from "../../src-tauri/web/src/workbench-state";
import { TimelineRecords } from "../../src-tauri/web/src/conversation/plan-updates";

function task(overrides: Partial<LeadSnapshot> = {}): LeadSnapshot {
  return {
    leadRunId: "task-1",
    messages: [],
    conversationEntries: [],
    workflowRevisions: [],
    executions: [],
    executionHistory: [],
    impactSummaries: [],
    decisions: [],
    ...overrides,
  } as unknown as LeadSnapshot;
}

function revision(n: number) {
  return { revision: n } as unknown as LeadSnapshot["workflowRevisions"][number];
}

function historyEvent(executionId: string, key: string, kind: "created" | "finished") {
  return {
    key,
    at: "2026-10-28T10:00:00.000Z",
    executionId,
    revision: 1,
    attempt: 1,
    kind,
    status: kind === "created" ? "running" : "completed",
    diagnostic: null,
    summary: null,
  } as LeadSnapshot["executionHistory"] extends (infer T)[] | undefined ? T : never;
}

test("执行历史身份与页面卡片一致，created/finished 合并为一张卡片", () => {
  const identities = unreadIdentities(
    task({
      executionHistory: [
        historyEvent("exec-1", "execution-created:exec-1", "created"),
        historyEvent("exec-1", "execution-finished:exec-1:7", "finished"),
      ],
    }),
  );
  expect(identities).toEqual(["execution:exec-1"]);
  expect(identities.some((id) => id.startsWith("execution-created:"))).toBe(false);
  expect(identities.some((id) => id.startsWith("execution-finished:"))).toBe(false);
});

test("方案版本按 revision 身份计数，重复不会重复累加", () => {
  const identities = unreadIdentities(
    task({ workflowRevisions: [revision(1), revision(2), revision(2)] }),
  );
  expect(identities).toEqual(["revision:1", "revision:2"]);
});

test("保存本地来源产生的版本不计入未读，避免用户自己的保存变成红点", () => {
  const identities = unreadIdentities(
    task({
      workflowRevisions: [
        { revision: 1, updateReason: "save-local" } as unknown as LeadSnapshot["workflowRevisions"][number],
        { revision: 2 } as unknown as LeadSnapshot["workflowRevisions"][number],
      ],
    }),
  );
  expect(identities).toEqual(["revision:2"]);
});

test("只有未完成正文时不回退到助手消息，避免产生无法标记的身份", () => {
  const base = task({
    messages: [
      { id: "m-user", role: "user", text: "目标", createdAt: "2026-10-28T10:00:00.000Z" },
      { id: "m-assistant", role: "assistant", text: "回答", createdAt: "2026-10-28T10:00:01.000Z" },
    ] as unknown as LeadSnapshot["messages"],
  });
  const streaming = unreadIdentities(
    task({
      ...base,
      messages: base.messages,
      conversationEntries: [
        {
          entryId: "e-1",
          turnId: "m-user",
          kind: "body",
          completed: false,
          seq: 1,
          startedAt: "2026-10-28T10:00:00.500Z",
          text: "半截",
        },
      ] as unknown as LeadSnapshot["conversationEntries"],
    }),
  );
  expect(streaming).toEqual([]);
});

test("读过之后未读归零，新增执行才重新出现", () => {
  const tracker = new UnreadTracker();
  const before = task({ workflowRevisions: [revision(1)] });
  expect(tracker.count(before, false)).toBe(0);

  const afterRevision = task({
    workflowRevisions: [revision(1), revision(2)],
    executionHistory: [historyEvent("exec-1", "execution-created:exec-1", "created")],
  });
  expect(tracker.count(afterRevision, false)).toBe(2);

  tracker.mark("task-1", unreadIdentities(afterRevision));
  expect(tracker.count(afterRevision, false)).toBe(0);
});

test("折叠组容器承载多个身份，看到组标题即可标记", () => {
  const html = renderToStaticMarkup(
    createElement(TimelineRecords, {
      items: [
        { key: "revision:1", at: "2026-10-28T10:00:00.000Z", planUpdate: "生成方案", content: null },
        { key: "revision:2", at: "2026-10-28T10:01:00.000Z", planUpdate: "修改方案", content: null },
      ],
    }),
  );
  expect(html).toContain('<details class="plan-update-group" data-read-identity="revision:1 revision:2"');
  expect(parseReadIdentities("revision:1 revision:2")).toEqual(["revision:1", "revision:2"]);
  expect(parseReadIdentities(undefined)).toEqual([]);
});
