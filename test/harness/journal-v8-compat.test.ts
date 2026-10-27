import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessJournal } from "../../src/harness/journal";
import { HarnessService } from "../../src/harness/service";
import type { HarnessSession } from "../../src/harness/session";
import type { HarnessStreamEvent } from "../../src/harness/types";
import { harnessRunsRoot } from "../../src/journal/paths";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class ImmediatePi implements HarnessSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  readonly prompts: string[] = [];
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(text: string) { this.isRunning = true; this.prompts.push(text); for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "durable answer" }); this.isRunning = false; return "durable answer"; }
  abort() { this.isRunning = false; }
}

/** v8 档案只缺 v9 新增事件与字段：必须按空队列兼容读取，且能继续追加 v9 事实。 */
test("v8 Harness 档案兼容读取：空队列、可继续发送与排队派发", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-v8-archive-"));
  directories.push(cwd);
  const root = harnessRunsRoot(cwd);
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  const journal = await HarnessJournal.create({ harnessRunId: id, cwd, version: 8, modelFingerprint: "a".repeat(64), createdAt: created }, root);
  await journal.append({ type: "harness.user_message", at: created, harnessRunId: id, message: { id: "m1", role: "user", text: "历史消息", createdAt: created } });

  const pi = new ImmediatePi();
  const service = new HarnessService(root, async () => pi);
  const snapshot = await service.snapshot(id);
  expect(snapshot.messages.map((message) => message.text)).toEqual(["历史消息"]);
  expect(snapshot.messageQueue).toEqual([]);

  await service.submit(id, "继续第一条");
  // 派发是异步的：必须等到"答案已落盘且回合已回到 idle"，只等消息条数会撞上
  // 仍在 running 的窗口。有界轮询，派发真的失效时依然会失败。
  let after = await service.snapshot(id);
  for (let attempt = 0; attempt < 200 && (after.status !== "idle" || after.messages.length < 3); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    after = await service.snapshot(id);
  }
  expect(after.status).toBe("idle");
  expect(after.messages.map((message) => message.text)).toEqual(["历史消息", "继续第一条", "durable answer"]);
  expect(pi.prompts).toEqual(["继续第一条"]);

  // v9 队列事件可以追加到同一档案，重放一致。
  const opened = await HarnessJournal.open(id, root);
  expect(opened.snapshot.messages).toHaveLength(3);
  expect(opened.snapshot.messageQueue).toEqual([]);
});
