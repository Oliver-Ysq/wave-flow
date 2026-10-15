import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessJournal } from "../../src/harness/journal";
import { createHash } from "node:crypto";
import { harnessRunsRoot } from "../../src/journal/paths";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("HarnessJournal", () => {
  test("预览补齐拒绝错误 hash、重复版本与未知 revision，合法升级保留审批身份", async () => {
    const value = await fixture();
    const source = 'test source', hash = createHash('sha256').update(source).digest('hex');
    const revision = { revision: 1, source, sourceHash: hash, createdAt: new Date().toISOString(), acceptedAt: null };
    await value.journal.append({ type: 'workflow.revision_proposed', at: revision.createdAt, harnessRunId: value.manifest.harnessRunId, revision });
    const preview = { previewVersion: 1, sourceHash: hash, phaseTitles: ['检查'], previewAgents: [] };
    const event = { type: 'workflow.revision_preview_saved' as const, at: revision.createdAt, harnessRunId: value.manifest.harnessRunId, revision: 1, preview };
    // Projection 与写入方必须先核对状态；此处用重放投影验证非法事件，避免污染档案。
    const { HarnessProjection } = await import('../../src/harness/journal');
    const opened = await HarnessJournal.open(value.manifest.harnessRunId, value.root);
    const projection = new HarnessProjection(value.manifest);
    for (const entry of opened.events) projection.apply(entry);
    expect(() => projection.apply({ ...event, revision: 99 })).toThrow('预览身份');
    expect(() => projection.apply({ ...event, preview: { ...preview, sourceHash: 'b'.repeat(64) } })).toThrow('预览身份');
    projection.apply(event);
    expect(() => projection.apply(event)).toThrow('版本');
    projection.apply({ ...event, preview: { ...preview, previewVersion: 2 } });
    expect(projection.snapshot().workflowRevisions[0]).toMatchObject({ ...revision, preview: { ...preview, previewVersion: 2 } });
    await expect(value.journal.append({ ...event, preview: { ...preview, previewAgents: [{ key: 'x', name: 'x', cli: null, phaseTitle: null, loop: 'yes' }] } as never })).rejects.toThrow();
  });
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

  /** v5 对话条目测试的通用回合开头。 */
  async function beginTurn(value: Awaited<ReturnType<typeof fixture>>) {
    const user = { id: crypto.randomUUID(), role: "user" as const, text: "hello", createdAt: new Date().toISOString() };
    await value.journal.append({ type: "harness.user_message", at: user.createdAt, harnessRunId: value.manifest.harnessRunId, message: user });
    await value.journal.append({ type: "harness.turn_started", at: new Date().toISOString(), harnessRunId: value.manifest.harnessRunId, userMessageId: user.id });
    return user;
  }
  const at = () => new Date().toISOString();
  const bodyEntry = (turnId: string, seq: number): import("../../src/harness/types").HarnessBodyEntry => ({ kind: "body", entryId: crypto.randomUUID(), turnId, seq, legacy: false, text: "", completed: false, truncated: false, startedAt: at(), finishedAt: null });
  const toolEntry = (turnId: string, seq: number): import("../../src/harness/types").HarnessToolEntry => ({ kind: "tool", entryId: crypto.randomUUID(), turnId, seq, legacy: false, callId: crypto.randomUUID(), source: "engine-mcp", name: "读取项目文件", toolKind: "file-read", target: "package.json", paramsSummary: "{\"path\":\"package.json\"}", startedAt: at(), finishedAt: null, status: "running", output: null, outputTruncated: false, exitCode: null, hasDetail: true });

  test("v5 对话条目逐事件耐久，重放后与写入时一致", async () => {
    const value = await fixture();
    const user = await beginTurn(value);
    const body = bodyEntry(user.id, 1);
    const tool = toolEntry(user.id, 2);
    await value.journal.append({ type: "harness.entry_started", at: at(), harnessRunId: value.manifest.harnessRunId, entry: body });
    await value.journal.append({ type: "harness.entry_appended", at: at(), harnessRunId: value.manifest.harnessRunId, entryId: body.entryId, text: "你好", truncated: false });
    await value.journal.append({ type: "harness.entry_started", at: at(), harnessRunId: value.manifest.harnessRunId, entry: tool });
    const toolFinished = { ...tool, status: "completed" as const, finishedAt: at(), output: "  1  {}", outputTruncated: false };
    await value.journal.append({ type: "harness.entry_finished", at: at(), harnessRunId: value.manifest.harnessRunId, entry: toolFinished });
    const bodyFinished = { ...body, text: "你好", completed: true, finishedAt: at() };
    await value.journal.append({ type: "harness.entry_finished", at: at(), harnessRunId: value.manifest.harnessRunId, entry: bodyFinished });
    const assistant = { id: crypto.randomUUID(), role: "assistant" as const, text: "你好", createdAt: at() };
    await value.journal.append({ type: "harness.assistant_message", at: at(), harnessRunId: value.manifest.harnessRunId, message: assistant });
    await value.journal.append({ type: "harness.turn_finished", at: at(), harnessRunId: value.manifest.harnessRunId, messageId: assistant.id });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).resolves.toMatchObject({ snapshot: { status: "idle", conversationEntries: [bodyFinished, toolFinished] } });
  });

  test("未终结对话条目阻断回合终结，重放 fail closed", async () => {
    const value = await fixture();
    const user = await beginTurn(value);
    await value.journal.append({ type: "harness.entry_started", at: at(), harnessRunId: value.manifest.harnessRunId, entry: bodyEntry(user.id, 1) });
    const assistant = { id: crypto.randomUUID(), role: "assistant" as const, text: "answer", createdAt: at() };
    await value.journal.append({ type: "harness.assistant_message", at: at(), harnessRunId: value.manifest.harnessRunId, message: assistant });
    await value.journal.append({ type: "harness.turn_finished", at: at(), harnessRunId: value.manifest.harnessRunId, messageId: assistant.id });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("未终结对话条目");
  });

  test("对话条目必须属于当前运行中回合且序号递增", async () => {
    const value = await fixture();
    const user = await beginTurn(value);
    await value.journal.append({ type: "harness.entry_started", at: at(), harnessRunId: value.manifest.harnessRunId, entry: bodyEntry(crypto.randomUUID(), 1) });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("必须属于当前运行中回合");
    const other = await fixture();
    const otherUser = await beginTurn(other);
    await other.journal.append({ type: "harness.entry_started", at: at(), harnessRunId: other.manifest.harnessRunId, entry: bodyEntry(otherUser.id, 2) });
    await expect(HarnessJournal.open(other.manifest.harnessRunId, other.root)).rejects.toThrow("序号必须严格递增");
  });

  test("非法对话条目事件在写入时即被拒绝", async () => {
    const value = await fixture();
    const user = await beginTurn(value);
    const running = toolEntry(user.id, 1);
    await expect(value.journal.append({ type: "harness.entry_finished", at: at(), harnessRunId: value.manifest.harnessRunId, entry: running })).rejects.toThrow("entry_finished");
    await value.journal.append({ type: "harness.entry_started", at: at(), harnessRunId: value.manifest.harnessRunId, entry: running });
    await expect(value.journal.append({ type: "harness.entry_appended", at: at(), harnessRunId: value.manifest.harnessRunId, entryId: running.entryId, text: "", truncated: false })).rejects.toThrow("entry_appended");
    const finished = { ...running, status: "completed" as const, finishedAt: at() };
    await value.journal.append({ type: "harness.entry_finished", at: at(), harnessRunId: value.manifest.harnessRunId, entry: finished });
    await expect(value.journal.append({ type: "harness.entry_appended", at: at(), harnessRunId: value.manifest.harnessRunId, entryId: running.entryId, text: "late", truncated: false })).resolves.toBeUndefined();
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("不存在或已终结");
  });

  test("v1 历史工具摘要重建为 legacy 条目：缺失详情不补造", async () => {
    const value = await fixture();
    const user = await beginTurn(value);
    const assistant = { id: crypto.randomUUID(), role: "assistant" as const, text: "answer", createdAt: at() };
    await value.journal.append({ type: "harness.assistant_message", at: at(), harnessRunId: value.manifest.harnessRunId, message: assistant });
    const activity = { label: "读取项目文件", finishedAt: at(), outcome: "completed" as const };
    await value.journal.append({ type: "harness.tool_activity", at: at(), harnessRunId: value.manifest.harnessRunId, messageId: assistant.id, activities: [activity] });
    await value.journal.append({ type: "harness.turn_finished", at: at(), harnessRunId: value.manifest.harnessRunId, messageId: assistant.id });
    const opened = await HarnessJournal.open(value.manifest.harnessRunId, value.root);
    expect(opened.snapshot.conversationEntries).toEqual([
      expect.objectContaining({ kind: "tool", legacy: true, hasDetail: false, name: "读取项目文件", status: "completed", output: null, paramsSummary: null, turnId: user.id }),
    ]);
    expect(opened.snapshot.toolActivitiesByMessageId[assistant.id]).toEqual([activity]);
  });

  test("草案拒绝是不可逆耐久事实：重放保留，拒绝后不能接受或执行，已接受不能反向拒绝", async () => {
    const value = await fixture();
    const revision = { revision: 1, source: "export default async function run() {}", sourceHash: "b".repeat(64), createdAt: at(), acceptedAt: null };
    await value.journal.append({ type: "workflow.revision_proposed", at: revision.createdAt, harnessRunId: value.manifest.harnessRunId, revision });
    const rejectedAt = at();
    await value.journal.append({ type: "workflow.revision_rejected", at: rejectedAt, harnessRunId: value.manifest.harnessRunId, revision: 1 });
    const opened = await HarnessJournal.open(value.manifest.harnessRunId, value.root);
    expect(opened.snapshot.workflowRevisions).toMatchObject([{ revision: 1, acceptedAt: null, rejectedAt }]);
    // 已拒绝草案不能接受。
    await value.journal.append({ type: "workflow.revision_accepted", at: at(), harnessRunId: value.manifest.harnessRunId, revision: 1 });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("未接受且未拒绝");
  });

  test("重复拒绝与非最新草案拒绝均 fail closed", async () => {
    const value = await fixture();
    const revision = { revision: 1, source: "export default async function run() {}", sourceHash: "b".repeat(64), createdAt: at(), acceptedAt: null };
    await value.journal.append({ type: "workflow.revision_proposed", at: revision.createdAt, harnessRunId: value.manifest.harnessRunId, revision });
    await value.journal.append({ type: "workflow.revision_rejected", at: at(), harnessRunId: value.manifest.harnessRunId, revision: 1 });
    await value.journal.append({ type: "workflow.revision_rejected", at: at(), harnessRunId: value.manifest.harnessRunId, revision: 1 });
    await expect(HarnessJournal.open(value.manifest.harnessRunId, value.root)).rejects.toThrow("只能拒绝最新未接受且未拒绝草案");
    const accepted = await fixture();
    const proposed = { revision: 1, source: "export default async function run() {}", sourceHash: "c".repeat(64), createdAt: at(), acceptedAt: null };
    await accepted.journal.append({ type: "workflow.revision_proposed", at: proposed.createdAt, harnessRunId: accepted.manifest.harnessRunId, revision: proposed });
    await accepted.journal.append({ type: "workflow.revision_accepted", at: at(), harnessRunId: accepted.manifest.harnessRunId, revision: 1 });
    await accepted.journal.append({ type: "workflow.revision_rejected", at: at(), harnessRunId: accepted.manifest.harnessRunId, revision: 1 });
    await expect(HarnessJournal.open(accepted.manifest.harnessRunId, accepted.root)).rejects.toThrow("只能拒绝最新未接受且未拒绝草案");
  });
});
