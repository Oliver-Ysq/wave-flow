import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessJournal } from "../../src/harness/journal";
import { harnessRunsRoot } from "../../src/journal/paths";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("HarnessJournal", () => {
  async function fixture() {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-")); directories.push(cwd);
    const root = harnessRunsRoot(cwd);
    const manifest = { harnessRunId: crypto.randomUUID(), version: 1 as const, cwd, modelFingerprint: "a".repeat(64), createdAt: new Date().toISOString() };
    return { cwd, root, journal: await HarnessJournal.create(manifest, root), manifest };
  }
  test("只耐久完整消息与绑定 assistant 的最小工具摘要，reasoning 不进入 Journal", async () => {
    const value = await fixture();
    const user = { id: crypto.randomUUID(), role: "user" as const, text: "hello", createdAt: new Date().toISOString() };
    const assistant = { id: crypto.randomUUID(), role: "assistant" as const, text: "answer", createdAt: new Date().toISOString() };
    await value.journal.append({ type: "harness.user_message", at: user.createdAt, harnessRunId: value.manifest.harnessRunId, message: user });
    await value.journal.append({ type: "harness.turn_started", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, userMessageId: user.id });
    await value.journal.append({ type: "harness.assistant_message", at: assistant.createdAt, harnessRunId: value.manifest.harnessRunId, message: assistant });
    const activity = { label: "读取项目文件", finishedAt: new Date().toISOString(), outcome: "completed" as const };
    await value.journal.append({ type: "harness.tool_activity", at: activity.finishedAt, harnessRunId: value.manifest.harnessRunId, messageId: assistant.id, activities: [activity] });
    await value.journal.append({ type: "harness.turn_finished", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, messageId: assistant.id });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).resolves.toMatchObject({ snapshot: { status: "idle", messages: [user, assistant], toolActivitiesByMessageId: { [assistant.id]: [activity] } } });
  });
  test("工具摘要只允许绑定当前 assistant 且拒绝敏感字段", async () => {
    const value = await fixture();
    const user = { id: crypto.randomUUID(), role: "user" as const, text: "hello", createdAt: new Date().toISOString() };
    const assistant = { id: crypto.randomUUID(), role: "assistant" as const, text: "answer", createdAt: new Date().toISOString() };
    await value.journal.append({ type: "harness.user_message", at: user.createdAt, harnessRunId: value.manifest.harnessRunId, message: user });
    await value.journal.append({ type: "harness.turn_started", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, userMessageId: user.id });
    await expect(value.journal.append({ type: "harness.tool_activity", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, messageId: assistant.id, activities: [{ label: "读取项目文件", finishedAt: new Date().toISOString(), outcome: "completed", path: "/secret" } as unknown as import("../../src/harness/types").HarnessToolActivity] })).rejects.toThrow("tool_activity");
    await value.journal.append({ type: "harness.assistant_message", at: assistant.createdAt, harnessRunId: value.manifest.harnessRunId, message: assistant });
    await expect(value.journal.append({ type: "harness.tool_activity", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, messageId: crypto.randomUUID(), activities: [{ label: "读取项目文件", finishedAt: new Date().toISOString(), outcome: "completed" }] })).resolves.toBeUndefined();
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("必须绑定当前 assistant");
  });
  test("乱序 turn 与未知 reasoning 事实不能重开", async () => {
    const value = await fixture();
    await appendFile(join(value.journal.directory, "journal.jsonl"), `${JSON.stringify({ type: "harness.reasoning_delta", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, delta: "secret" })}\n`, "utf8");
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("事件类型");
  });

  test("Workflow revision 接受后重开仍保留同一 source/hash 与冻结事实", async () => {
    const value = await fixture();
    const revision = { revision: 1, source: "export default async function run() {}", sourceHash: "b".repeat(64), createdAt: new Date().toISOString(), acceptedAt: null };
    await value.journal.append({ type: "workflow.revision_proposed", at: revision.createdAt, harnessRunId: value.manifest.harnessRunId, revision });
    const acceptedAt = new Date().toISOString();
    await value.journal.append({ type: "workflow.revision_accepted", at: acceptedAt, harnessRunId: value.manifest.harnessRunId, revision: 1 });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).resolves.toMatchObject({ snapshot: { workflowRevisions: [{ revision: 1, source: revision.source, sourceHash: revision.sourceHash, acceptedAt }] } });
  });

  test("完成事件重开后保持终态，并拒绝任何后续事实", async () => {
    const value = await fixture();
    const completedAt = new Date().toISOString();
    await value.journal.append({ type: "harness.completed", at: completedAt, harnessRunId: value.manifest.harnessRunId });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).resolves.toMatchObject({ snapshot: { status: "completed", completedAt } });
    // 低层文件被绕过篡改时，重放必须 fail closed，不能把完成档案伪装成可继续对话。
    await appendFile(join(value.journal.directory, "journal.jsonl"), `${JSON.stringify({ type: "harness.user_message", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, message: { id: crypto.randomUUID(), role: "user", text: "late", createdAt: new Date().toISOString() } })}\n`, "utf8");
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("已完成的 Harness 不能追加新事实");
  });

  test("拒绝权限过宽的 Harness 状态文件", async () => {
    const value = await fixture();
    await chmod(join(value.journal.directory, "journal.jsonl"), 0o644);
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("Journal 不可读取");
  });

  test("追加拒绝被替换为软链接或权限过宽的 Journal", async () => {
    const value = await fixture();
    const journalPath = join(value.journal.directory, "journal.jsonl");
    await chmod(journalPath, 0o644);
    await expect(value.journal.append({ type: "harness.turn_interrupted", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, diagnostic: "x" })).rejects.toThrow("不安全");
    await chmod(journalPath, 0o600);
    const target = join(value.cwd, "target.txt"); await writeFile(target, "safe", "utf8");
    await rm(journalPath); await symlink(target, journalPath);
    await expect(value.journal.append({ type: "harness.turn_interrupted", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, diagnostic: "x" })).rejects.toThrow();
    await expect(Bun.file(target).text()).resolves.toBe("safe");
  });
});
