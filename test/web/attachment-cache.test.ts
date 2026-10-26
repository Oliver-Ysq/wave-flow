import { expect, test } from "bun:test";
import { AttachmentDataCache, ATTACHMENT_CACHE_MAX_CHARS, ATTACHMENT_CACHE_MAX_ENTRIES } from "../../src-tauri/web/src/conversation/attachment-cache";

test("条目数有界：超出后逐出最旧条目", () => {
  const cache = new AttachmentDataCache(3, Number.MAX_SAFE_INTEGER);
  cache.set("a", "1"); cache.set("b", "2"); cache.set("c", "3"); cache.set("d", "4");
  expect(cache.size).toBe(3);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBe("2");
});

test("总字符数有界：少量大字符串也会触发逐出，不会涨到 GB 级", () => {
  const cache = new AttachmentDataCache(100, 10);
  cache.set("big1", "x".repeat(6));
  cache.set("big2", "y".repeat(6));
  expect(cache.totalChars).toBeLessThanOrEqual(10);
  expect(cache.get("big1")).toBeUndefined();
  expect(cache.get("big2")).toBe("y".repeat(6));
});

test("读取刷新 LRU：最近读过的条目在超限时不被逐出", () => {
  const cache = new AttachmentDataCache(2, Number.MAX_SAFE_INTEGER);
  cache.set("a", "1"); cache.set("b", "2");
  expect(cache.get("a")).toBe("1");
  cache.set("c", "3");
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe("1");
  expect(cache.get("c")).toBe("3");
});

test("同键覆盖不重复计数，单条超限宁可不缓存", () => {
  const cache = new AttachmentDataCache(10, 8);
  cache.set("k", "1234"); cache.set("k", "123456");
  expect(cache.totalChars).toBe(6);
  cache.set("huge", "x".repeat(9));
  expect(cache.get("huge")).toBeUndefined();
  expect(cache.totalChars).toBe(6);
});

test("conversation-view 使用有界 LRU 而不是裸 Map + 128 条手工逐出", async () => {
  const view = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(view).toContain('from "./attachment-cache"');
  expect(view).toContain("new AttachmentDataCache()");
  expect(view).not.toContain("attachmentDataCache.size > 128");
  expect(ATTACHMENT_CACHE_MAX_ENTRIES).toBe(128);
  expect(ATTACHMENT_CACHE_MAX_CHARS).toBe(64 * 1024 * 1024);
});
