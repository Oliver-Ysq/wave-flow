import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HarnessJournal } from "../../src/harness/journal";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessService } from "../../src/harness/service";
import type { HarnessSession } from "../../src/harness/session";
import type { HarnessStreamEvent } from "../../src/harness/types";
import { harnessRunsRoot } from "../../src/journal/paths";


const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("revision 预览提案时耐久，旧档案并发补齐一次，重开不重复保存", async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'wave-flow-preview-durable-')); directories.push(cwd);
  const root = harnessRunsRoot(cwd);
  const source = `const meta = { name: 'durable-preview', description: '预览', phases: [{ title: '检查' }] }; async function run(args) { phase('检查'); for (const item of args.items) await agent('检查', { id: item.id, cli: 'kimi', label: '检查 Agent' }); return {}; }`;
  const service = new HarnessService(root, async () => new FakePi());
  const created = await service.create(cwd);
  const proposed = await service.proposeWorkflowRevision(created.harnessRunId, source);
  expect(proposed.workflowRevisions[0]?.preview).toMatchObject({ previewVersion: 3,description:"预览",workflowName:"durable-preview", sourceHash: proposed.workflowRevisions[0]?.sourceHash, phaseTitles: ['检查'], previewAgents: [{ name: '检查 Agent', loop: true }] });
  const saved = await HarnessJournal.open(created.harnessRunId, root);
  expect(saved.snapshot.workflowRevisions[0]?.preview).toEqual(proposed.workflowRevisions[0]?.preview);
  expect(saved.events.filter(event => event.type === 'workflow.revision_preview_saved')).toHaveLength(0);

  const legacyId = crypto.randomUUID();
  const journal = await HarnessJournal.create({ harnessRunId: legacyId, cwd, version: 9, modelFingerprint: 'a'.repeat(64), createdAt: new Date().toISOString() }, root);
  const revision = { revision: 1, source, sourceHash: createHash('sha256').update(source).digest('hex'), createdAt: new Date().toISOString(), acceptedAt: null, rejectedAt: null };
  await journal.append({ type: 'workflow.revision_proposed', at: revision.createdAt, harnessRunId: legacyId, revision });
  await journal.append({ type: 'workflow.revision_accepted', at: revision.createdAt, harnessRunId: legacyId, revision: 1 });
  const opened = new HarnessService(root, async () => new FakePi());
  const snapshots = await Promise.all([opened.snapshot(legacyId), opened.snapshot(legacyId), opened.snapshot(legacyId)]);
  expect(snapshots[0]?.workflowRevisions[0]?.preview).toEqual(proposed.workflowRevisions[0]?.preview);
  const once = await HarnessJournal.open(legacyId, root);
  expect(once.events.filter(event => event.type === 'workflow.revision_preview_saved')).toHaveLength(1);
  expect(once.snapshot.executions).toEqual([]);
  expect(once.snapshot.workflowRevisions[0]?.acceptedAt).toBe(revision.createdAt);
  const reopened = new HarnessService(root, async () => new FakePi());
  // 已保存预览重开不得再进入编译/AST 生成路径。
  (reopened as unknown as { buildRevisionPreview: () => never }).buildRevisionPreview = () => { throw new Error('unexpected preview rebuild'); };
  await reopened.snapshot(legacyId);
  expect((await reopened.snapshot(legacyId)).workflowRevisions[0]?.preview).toEqual(proposed.workflowRevisions[0]?.preview);
  expect((await HarnessJournal.open(legacyId, root)).events).toEqual(once.events);
});

test("旧源码不再满足编译规则时只降级预览，不阻断聊天重开", async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'wave-flow-preview-legacy-')); directories.push(cwd);
  const root = harnessRunsRoot(cwd), harnessRunId = crypto.randomUUID();
  const journal = await HarnessJournal.create({ harnessRunId, cwd, version: 9, modelFingerprint: 'a'.repeat(64), createdAt: new Date().toISOString() }, root);
  const source = 'old invalid source';
  await journal.append({ type: 'workflow.revision_proposed', at: new Date().toISOString(), harnessRunId, revision: { revision: 1, source, sourceHash: createHash('sha256').update(source).digest('hex'), createdAt: new Date().toISOString(), acceptedAt: null } });
  const opened = new HarnessService(root, async () => new FakePi());
  expect((await opened.snapshot(harnessRunId)).workflowRevisions[0]?.preview).toBeUndefined();
  expect((await opened.snapshot(harnessRunId)).status).toBe('idle');
  expect((await HarnessJournal.open(harnessRunId, root)).events).toHaveLength(2);
});
const testModel = { model: "test", baseUrl: "https://example.test/v1", apiKey: "test-key" };

class FakePi implements HarnessSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(text: string) { this.isRunning = true; for (const listener of this.#listeners) { listener({ type: "reasoning_delta", delta: `<think>${text}</think>` }); listener({ type: "assistant_delta", delta: "durable answer" }); } this.isRunning = false; return "durable answer"; }
  abort() { this.isRunning = false; }
}

class InterruptedPi implements HarnessSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(_text: string): Promise<string> { this.isRunning = true; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "partial text" }); this.isRunning = false; throw new Error("provider disconnected"); }
  abort() { this.isRunning = false; }
}

class EmptyPi implements HarnessSession {
  isRunning = false;
  subscribe(_listener: (event: HarnessStreamEvent) => void) { return () => {}; }
  async prompt(_text: string): Promise<string> { return ""; }
  abort() { this.isRunning = false; }
}

class UnverifiedProjectPi implements HarnessSession {
  isRunning = false;
  subscribe(_listener: (event: HarnessStreamEvent) => void) { return () => {}; }
  async prompt(_text: string): Promise<string> { throw new Error("主控未执行任何已验证只读工具，拒绝耐久项目事实结论。 "); }
  abort() { this.isRunning = false; }
}

class DeferredPi implements HarnessSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  #resolve: ((value: string) => void) | null = null;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  prompt(_text: string): Promise<string> { this.isRunning = true; return new Promise(resolve => { this.#resolve = resolve; }); }
  finish() { this.isRunning = false; this.#resolve?.("finished"); }
  abort() { this.isRunning = false; this.#resolve?.(""); }
}

class ClosablePi extends FakePi {
  closed = false;
  close() { this.closed = true; }
}

describe("HarnessService", () => {
  test("关闭服务释放已复用的主控 session，不写入额外 Journal 事实", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-close-")); directories.push(cwd);
    const pi = new ClosablePi();
    const service = new HarnessService(harnessRunsRoot(cwd), async () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "hello");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const before = await service.snapshot(created.harnessRunId);
    service.close();
    expect(pi.closed).toBe(true);
    await expect(service.snapshot(created.harnessRunId)).resolves.toEqual(before);
  });
  test("设置代际：关闭空闲会话后下一回合重建，历史从耐久消息续接", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-session-epoch-")); directories.push(cwd);
    let created = 0;
    const sessions: ClosablePi[] = [];
    const service = new HarnessService(harnessRunsRoot(cwd), async () => { created += 1; const pi = new ClosablePi(); sessions.push(pi); return pi; });
    const task = await service.create(cwd);
    await service.send(task.harnessRunId, "first");
    await waitFor(async () => (await service.snapshot(task.harnessRunId)).status === "idle");
    service.closeIdleSessions();
    // 空闲会话按新设置关闭；旧 session 不能被下一回合复用。
    expect(sessions[0]?.closed).toBe(true);
    await service.send(task.harnessRunId, "second");
    await waitFor(async () => (await service.snapshot(task.harnessRunId)).status === "idle");
    expect(created).toBe(2);
    expect((await service.snapshot(task.harnessRunId)).messages.filter(message => message.role === "user")).toHaveLength(2);
  });
  test("Desktop 退出先将运行中主控回合耐久为 interrupted，再关闭 session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-desktop-exit-")); directories.push(cwd);
    const pi = new DeferredPi();
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "仍在生成");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "running");
    await service.interruptForDesktopExit();
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ status: "interrupted", diagnostic: "退出 Wave Flow，主控回合已中断。 " });
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ status: "interrupted" });
  });
  test("Desktop 退出后迟到的主控回答不会污染已中断 Journal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-exit-late-answer-")); directories.push(cwd);
    const pi = new DeferredPi();
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "会迟到的回答");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "running");
    await service.interruptForDesktopExit();
    pi.finish();
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "interrupted");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [{ role: "user", text: "会迟到的回答" }] });
  });
  test("新 Engine 将遗留 running Harness 回合收敛为 interrupted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-stale-turn-")); directories.push(cwd);
    const pi = new DeferredPi();
    const original = new HarnessService(harnessRunsRoot(cwd), async () => pi);
    const created = await original.create(cwd);
    await original.send(created.harnessRunId, "模拟旧进程中断");
    await waitFor(async () => (await original.snapshot(created.harnessRunId)).status === "running");
    const restarted = new HarnessService(harnessRunsRoot(cwd), async () => new FakePi());
    await restarted.convergeStaleTurns();
    await expect(restarted.snapshot(created.harnessRunId)).resolves.toMatchObject({ status: "interrupted", diagnostic: expect.stringContaining("Desktop Engine 重启") });
    pi.abort();
  });
  test("创建 Harness 时冻结 session fingerprint，非法 fingerprint 不产生档案", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-fingerprint-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => new FakePi(), undefined, async () => ({ fingerprint: "a".repeat(64) }));
    await expect(service.create(cwd)).resolves.toMatchObject({ harnessRunId: expect.any(String) });
    const invalid = new HarnessService(harnessRunsRoot(cwd), async () => new FakePi(), undefined, async () => ({ fingerprint: "not-a-fingerprint" }));
    await expect(invalid.create(cwd)).rejects.toThrow("fingerprint");
  });
  test("reasoning 只流式展示，完整 assistant 回答才耐久", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-service-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => new FakePi());
    const created = await service.create(cwd);
    const events: HarnessStreamEvent[] = [];
    await service.subscribe(created.harnessRunId, (event) => events.push(event));
    await service.send(created.harnessRunId, "hello");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    expect(events).toEqual(expect.arrayContaining([{ type: "reasoning_delta", delta: "<think>hello</think>" }, { type: "assistant_delta", delta: "durable answer" }]));
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ status: "idle", messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "durable answer" }] });
  });

  test("主控回合的工具事实以颗粒化条目耐久，重开会话仍可恢复", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-tool-summary-")); directories.push(cwd);
    let service!: HarnessService;
    const pi: HarnessSession = {
      isRunning: false,
      subscribe: () => () => {},
      async prompt() {
        await service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "inspect_execution", arguments: {} } });
        return "已读取项目目录。";
      },
      abort() {},
    };
    service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "读取项目");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const completed = await service.snapshot(created.harnessRunId);
    // v5 起新回合不再写 harness.tool_activity 批量摘要（它会让新界面出现重复工具行）；
    // 工具目标、输出与状态由颗粒化条目承载，重开回放同源一致。
    const tool = completed.conversationEntries.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", toolKind: "mcp", status: "completed", source: "engine-mcp", hasDetail: true, legacy: false });
    expect(tool && tool.kind === "tool" ? tool.output : null).toContain("[");
    expect(completed.toolActivitiesByMessageId).toEqual({});
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ conversationEntries: completed.conversationEntries });
  });

  test("部分流或 provider 中断不耐久 assistant 消息", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-interrupted-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new InterruptedPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "hello");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "interrupted");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [{ role: "user", text: "hello" }], diagnostic: "provider disconnected" });
  });

  test("中断后下一轮从耐久 capsule 重建 Pi，不继承 partial state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-rebuild-")); directories.push(cwd);
    let createdPi = 0;
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => {
      createdPi += 1;
      return createdPi === 1 ? new InterruptedPi() : new FakePi();
    });
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "first");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "interrupted");
    await service.send(created.harnessRunId, "second");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    expect(createdPi).toBe(2);
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [
      { role: "user", text: "first" }, { role: "user", text: "second" }, { role: "assistant", text: "durable answer" },
    ] });
  });

  test("没有完整回答时也写 interrupted，绝不耐久空 assistant 消息", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-empty-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new EmptyPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "hello");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "interrupted");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [{ role: "user", text: "hello" }], diagnostic: "主控回答只包含非持久 reasoning。 " });
  });

  test("项目事实未由只读工具验证时不耐久 assistant 结论", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-unverified-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new UnverifiedProjectPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "请读取项目 package.json");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "interrupted");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [{ role: "user", text: "请读取项目 package.json" }], diagnostic: "主控未执行任何已验证只读工具，拒绝耐久项目事实结论。 " });
  });

  test("Workflow 草案先耐久 hash，接受只冻结 revision 而不启动 Worker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-revision-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    const created = await service.create(cwd);
    const source = 'const meta = { name: "draft", description: "draft", phases: [{ title: "plan" }] };\nasync function run(args) { return args; }';
    const proposed = await service.proposeWorkflowRevision(created.harnessRunId, source);
    expect(proposed.workflowRevisions).toHaveLength(1);
    expect(proposed.workflowRevisions[0]).toMatchObject({ revision: 1, source, acceptedAt: null, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(service.acceptWorkflowRevision(created.harnessRunId, 1)).resolves.toMatchObject({ workflowRevisions: [{ revision: 1, acceptedAt: expect.any(String) }] });
    await expect(service.acceptWorkflowRevision(created.harnessRunId, 1)).rejects.toThrow("未接受且未拒绝");
    const next = await service.proposeWorkflowRevision(created.harnessRunId, `${source}\n// revision 2`);
    expect(next.workflowRevisions).toHaveLength(2);
    expect(next.workflowRevisions[0].revision).toBe(1);
    expect(next.workflowRevisions[0].source).toBe(source);
    expect(next.workflowRevisions[0].acceptedAt).not.toBeNull();
    expect(next.workflowRevisions[1].revision).toBe(2);
    expect(next.workflowRevisions[1].acceptedAt).toBeNull();
  });

  test("并发发送只启动一个主控回合", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-send-lock-")); directories.push(cwd);
    const pi = new DeferredPi();
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => pi);
    const created = await service.create(cwd);
    const first = service.send(created.harnessRunId, "first");
    const second = service.send(created.harnessRunId, "second");
    await first;
    await expect(second).rejects.toThrow("仍在运行");
    pi.finish();
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [{ role: "user", text: "first" }, { role: "assistant", text: "finished" }] });
  });

  test("并发草案提案获得连续且唯一的 revision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-revision-lock-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    const created = await service.create(cwd);
    const draft = (name: string) => `const meta = { name: "${name}", description: "并发提案", phases: [{ title: "p" }] };\nasync function run(args) { return args; }`;
    await Promise.all([service.proposeWorkflowRevision(created.harnessRunId, draft("draft-one")), service.proposeWorkflowRevision(created.harnessRunId, draft("draft-two"))]);
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ workflowRevisions: [{ revision: 1 }, { revision: 2 }] });
  });

  test("用户完成会话后封存 Journal、释放 session，且拒绝后续写入", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-complete-")); directories.push(cwd);
    const pi = new ClosablePi();
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "完成前的消息");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");

    const completed = await service.complete(created.harnessRunId);
    expect(completed).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect(pi.closed).toBe(true);
    await expect(service.send(created.harnessRunId, "不应发送")).rejects.toThrow("完成归档");
    await expect(service.proposeWorkflowRevision(created.harnessRunId, 'const meta = { name: "late", description: "late", phases: [{ title: "p" }] }; async function run(args) { return args; }')).rejects.toThrow("完成归档");

    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ status: "completed", completedAt: completed.completedAt });
  });

  test("运行中的主控回合不能完成会话", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-complete-running-")); directories.push(cwd);
    const pi = new DeferredPi();
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "仍在运行");
    await expect(service.complete(created.harnessRunId)).rejects.toThrow("运行中");
    pi.finish();
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
  });

  test("不可编译草案在提案时即被拒绝，不产生任何 revision 事实", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-revision-invalid-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    const created = await service.create(cwd);
    // 主控最常见的生成错误：混入中文引号。拒绝必须发生在冻结之前，诊断必须可行动。
    const invalid = 'const meta = { name: "draft", description: "draft", phases: [{ title: "plan" }] };\nasync function run(args) { return agent(“审查代码”, { id: "a", cli: "codex" }); }';
    await expect(service.proposeWorkflowRevision(created.harnessRunId, invalid)).rejects.toThrow(/语法无效.*第 2 行.*U\+201C/s);
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ workflowRevisions: [] });
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ workflowRevisions: [] });
  });

  test("当前主控回合可经窄工具耐久草案，用户 API 仍不得在运行中抢写", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-action-revision-")); directories.push(cwd);
    let actions: import("../../src/harness/action-tools").HarnessActionCallbacks | null = null;
    let running = false;
    const pi: HarnessSession = {
      get isRunning() { return running; },
      subscribe: () => () => {},
      async prompt() {
        running = true;
        await actions!.proposeWorkflowRevision('const meta = { name: "action-revision", description: "来自主控工具", phases: [{ title: "确认" }] };\nasync function run(_args) { phase("确认"); return {}; }');
        running = false;
        return "草案已提交";
      },
      abort() { running = false; },
    };
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior, nextActions) => { actions = nextActions; return pi; });
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "请提出草案");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const snapshot = await service.snapshot(created.harnessRunId);
    expect(snapshot.workflowRevisions).toMatchObject([{ revision: 1, acceptedAt: null }]);
    expect(snapshot.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "草案已提交" })]));
  });

  test("正文与思考分段耐久：正文完成、思考各自计时，重开完整回放", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-stream-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => new FakePi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "hello");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const snapshot = await service.snapshot(created.harnessRunId);
    const body = snapshot.conversationEntries.find((entry) => entry.kind === "body");
    const thoughts = snapshot.conversationEntries.filter((entry) => entry.kind === "thought");
    expect(body).toMatchObject({ kind: "body", text: "durable answer", completed: true, truncated: false, finishedAt: expect.any(String) });
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({ kind: "thought", status: "completed", text: "<think>hello</think>", startedAt: expect.any(String), finishedAt: expect.any(String) });
    expect(snapshot.conversationEntries.map((entry) => entry.seq)).toEqual([1, 2]);
    // 重开回放必须与实时投影同源一致：条目 ID、正文、计时事实全部来自 Journal。
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ conversationEntries: snapshot.conversationEntries });
  });

  test("思考被正文/工具切断时分段为独立条目", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-thought-segments-")); directories.push(cwd);
    class SegmentedPi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      async prompt() {
        const emit = (event: HarnessStreamEvent) => { for (const listener of this.#listeners) listener(event); };
        emit({ type: "reasoning_delta", delta: "第一段" });
        emit({ type: "assistant_delta", delta: "中间正文" });
        emit({ type: "reasoning_delta", delta: "第二段" });
        emit({ type: "assistant_delta", delta: "完整回答" });
        return "中间正文完整回答";
      }
      abort() {}
    }
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new SegmentedPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "分段思考");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const thoughts = (await service.snapshot(created.harnessRunId)).conversationEntries.filter((entry) => entry.kind === "thought");
    expect(thoughts.map((entry) => entry.kind === "thought" ? entry.text : "")).toEqual(["第一段", "第二段"]);
    expect(thoughts.every((entry) => entry.kind === "thought" && entry.status === "completed")).toBe(true);
  });

  test("正文被工具/思考切断时另建条目，回放顺序与真实流一致", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-body-segments-")); directories.push(cwd);
    let service!: HarnessService;
    class BodySegmentPi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      async prompt() {
        const emit = (event: HarnessStreamEvent) => { for (const listener of this.#listeners) listener(event); };
        emit({ type: "assistant_delta", delta: "先读取项目" });
        await service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "inspect_execution", arguments: {} } });
        emit({ type: "assistant_delta", delta: "读取完成" });
        emit({ type: "reasoning_delta", delta: "检查结果" });
        emit({ type: "assistant_delta", delta: "准备验证" });
        emit({ type: "acp_tool_call", call: { callId: "native-check", title: "验证", name: "shell", toolKind: "command", status: "completed", locations: [], contentText: "ok", rawInput: null, rawOutput: null } });
        emit({ type: "assistant_delta", delta: "验证完成" });
        return "先读取项目读取完成准备验证验证完成";
      }
      abort() {}
    }
    service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new BodySegmentPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "正文分段");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const entries = (await service.snapshot(created.harnessRunId)).conversationEntries;
    // 工具后的新文字必须另建正文条目，不能并回首个正文段（否则回放顺序错乱）。
    expect(entries.map((entry) => entry.kind)).toEqual(["body", "tool", "body", "thought", "body", "tool", "body"]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const bodies = entries.filter((entry) => entry.kind === "body");
    expect(bodies.map((entry) => entry.kind === "body" ? entry.text : "")).toEqual(["先读取项目", "读取完成", "准备验证", "验证完成"]);
    expect(bodies.every((entry) => entry.kind === "body" && entry.completed)).toBe(true);
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ conversationEntries: entries });
  });

  test("工具调用在回合进行中已耐久可见：运行中条目先于回合结束出现", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-live-tool-")); directories.push(cwd);
    let service!: HarnessService;
    const pi: HarnessSession = {
      isRunning: false,
      subscribe: () => () => {},
      async prompt() {
        const result = await service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "request_user_decision", arguments: { question: "继续吗？" } } });
        return `决定：${JSON.stringify((result as { answer: unknown }).answer)}`;
      },
      abort() {},
    };
    service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    const events: HarnessStreamEvent[] = [];
    await service.subscribe(created.harnessRunId, (event) => events.push(event));
    await service.send(created.harnessRunId, "需要决定");
    // 回合仍在进行（决策未答），运行中工具条目必须已经耐久并出现在快照里。
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).conversationEntries.some((entry) => entry.kind === "tool"));
    const mid = await service.snapshot(created.harnessRunId);
    const runningTool = mid.conversationEntries.find((entry) => entry.kind === "tool");
    expect(runningTool).toMatchObject({ kind: "tool", name: "等待用户决定", toolKind: "mcp", status: "running", target: "继续吗？", hasDetail: true, legacy: false });
    expect(mid.status).toBe("running");
    expect(events.some((event) => event.type === "entry_started" && event.entry.kind === "tool")).toBe(true);
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).decisions.length > 0);
    const decision = (await service.snapshot(created.harnessRunId)).decisions.at(-1)!;
    await service.answerUserDecision(created.harnessRunId, decision.decisionId, { continue: true });
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const done = (await service.snapshot(created.harnessRunId)).conversationEntries.find((entry) => entry.kind === "tool");
    expect(done).toMatchObject({ status: "completed", finishedAt: expect.any(String) });
    expect(done && done.kind === "tool" ? done.output : null).toContain("continue");
  });

  test("工具输出遮蔽已知凭据形态，超限时标记截断", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-redact-")); directories.push(cwd);
    let service!: HarnessService;
    const pi: HarnessSession = {
      isRunning: false,
      subscribe: () => () => {},
      async prompt() {
        await service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "request_user_decision", arguments: { question: "key?" } } });
        return "done";
      },
      abort() {},
    };
    service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => pi);
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "redact");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).decisions.length > 0);
    const decision = (await service.snapshot(created.harnessRunId)).decisions.at(-1)!;
    await service.answerUserDecision(created.harnessRunId, decision.decisionId, { key: "sk-abcdefghSECRETKEY0123456789" });
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const tool = (await service.snapshot(created.harnessRunId)).conversationEntries.find((entry) => entry.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.output : "").not.toContain("SECRETKEY0123456789");
    expect(tool && tool.kind === "tool" ? tool.output : "").toContain("sk-abcdefgh…");
  });

  test("中断回合保留未完成正文与 interrupted 条目，重开如实回放", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-interrupt-entries-")); directories.push(cwd);
    class HangingPi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      prompt(): Promise<string> { this.isRunning = true; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "写了一半" }); return new Promise(() => {}); }
      abort() { this.isRunning = false; }
    }
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new HangingPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "写长文");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "running");
    await service.interruptForDesktopExit();
    const snapshot = await service.snapshot(created.harnessRunId);
    expect(snapshot.status).toBe("interrupted");
    const body = snapshot.conversationEntries.find((entry) => entry.kind === "body");
    expect(body).toMatchObject({ kind: "body", text: "写了一半", completed: false, finishedAt: expect.any(String) });
    expect(snapshot.messages).toHaveLength(1);
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ conversationEntries: snapshot.conversationEntries });
  });

  test("崩溃恢复：旧进程遗留的未终结条目在重启收敛时补写 interrupted", async () => {    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-orphan-entries-")); directories.push(cwd);
    class DeltaThenHangPi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      prompt(): Promise<string> { this.isRunning = true; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "残留文本" }); return new Promise(() => {}); }
      abort() { this.isRunning = false; }
    }
    const original = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new DeltaThenHangPi());
    const created = await original.create(cwd);
    await original.send(created.harnessRunId, "模拟进程崩溃");
    // 等正文片段已耐久落盘（合并窗口刷新完成），随后模拟原进程直接消失。
    await waitFor(async () => (await original.snapshot(created.harnessRunId)).conversationEntries.some((entry) => entry.kind === "body" && entry.text.length > 0), 2_000);
    const restarted = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new FakePi());
    await restarted.convergeStaleTurns();
    const snapshot = await restarted.snapshot(created.harnessRunId);
    expect(snapshot.status).toBe("interrupted");
    const body = snapshot.conversationEntries.find((entry) => entry.kind === "body");
    expect(body).toMatchObject({ kind: "body", text: "残留文本", completed: false, finishedAt: expect.any(String) });
  });

  test("ACP 侧 mcp__server__tool 编码名通知与 Engine 包装器归并，不产生重复工具条目", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-acp-dedupe-")); directories.push(cwd);
    await writeFile(join(cwd, "package.json"), '{"name":"dedupe"}', "utf8");
    let service!: HarnessService;
    class DedupePi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      async prompt() {
        // 形态一：name 携带编码名；形态二：name 缺省、仅 title 携带（真实 Kimi CLI 行为）。
        for (const listener of this.#listeners) listener({ type: "acp_tool_call", call: { callId: "acp-1", title: "mcp__wave-flow-harness__inspect_execution", name: "mcp__wave-flow-harness__inspect_execution", toolKind: "mcp", status: "in_progress", locations: [], contentText: null, rawInput: {}, rawOutput: null } });
        await service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "inspect_execution", arguments: {} } });
        for (const listener of this.#listeners) listener({ type: "acp_tool_update", callId: "acp-1", patch: { status: "completed", contentText: "{}" } });
        for (const listener of this.#listeners) listener({ type: "acp_tool_call", call: { callId: "acp-2", title: "mcp__wave-flow-harness__read_run_capsule", name: null, toolKind: "mcp", status: "in_progress", locations: [], contentText: null, rawInput: null, rawOutput: null } });
        await service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "read_run_capsule", arguments: {} } });
        for (const listener of this.#listeners) listener({ type: "acp_tool_update", callId: "acp-2", patch: { status: "completed" } });
        return "已读取。";
      }
      abort() {}
    }
    service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new DedupePi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "读取 package.json");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const tools = (await service.snapshot(created.harnessRunId)).conversationEntries.filter((entry) => entry.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((entry) => entry.kind === "tool" ? entry.source : "")).toEqual(["engine-mcp", "engine-mcp"]);
  });

  test("ACP 原生工具的 content 更新按替换语义记录，终态保留最新快照", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-acp-replace-")); directories.push(cwd);
    class NativeToolPi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      async prompt() {
        for (const listener of this.#listeners) listener({ type: "acp_tool_call", call: { callId: "n-1", title: "运行测试", name: "shell", toolKind: "command", status: "in_progress", locations: [], contentText: null, rawInput: { cmd: "bun test" }, rawOutput: null } });
        for (const listener of this.#listeners) listener({ type: "acp_tool_update", callId: "n-1", patch: { contentText: "第一行" } });
        for (const listener of this.#listeners) listener({ type: "acp_tool_update", callId: "n-1", patch: { contentText: "第一行\n第二行" } });
        for (const listener of this.#listeners) listener({ type: "acp_tool_update", callId: "n-1", patch: { status: "completed", contentText: "第一行\n第二行\n完成" } });
        return "测试完成。";
      }
      abort() {}
    }
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new NativeToolPi());
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "运行测试");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    const tool = (await service.snapshot(created.harnessRunId)).conversationEntries.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", source: "acp", name: "运行测试", toolKind: "command", status: "completed" });
    expect(tool && tool.kind === "tool" ? tool.output : null).toBe("第一行\n第二行\n完成");
  });

  test("拒绝草案写入耐久事实：拒绝后不能接受，已接受不能反向拒绝", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-reject-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    const created = await service.create(cwd);
    const source = 'const meta = { name: "reject-draft", description: "拒绝路径", phases: [{ title: "p" }] };\nasync function run(args) { return args; }';
    await service.proposeWorkflowRevision(created.harnessRunId, source);
    await expect(service.rejectWorkflowRevision(created.harnessRunId, 1)).resolves.toMatchObject({ workflowRevisions: [{ revision: 1, acceptedAt: null, rejectedAt: expect.any(String) }] });
    await expect(service.acceptWorkflowRevision(created.harnessRunId, 1)).rejects.toThrow("未接受且未拒绝");
    await expect(service.rejectWorkflowRevision(created.harnessRunId, 1)).rejects.toThrow("只能拒绝最新未接受且未拒绝草案");
    const reopened = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    await expect(reopened.snapshot(created.harnessRunId)).resolves.toMatchObject({ workflowRevisions: [{ revision: 1, rejectedAt: expect.any(String) }] });
    // 已接受草案不能反向拒绝。
    const second = await service.create(cwd);
    await service.proposeWorkflowRevision(second.harnessRunId, source);
    await service.acceptWorkflowRevision(second.harnessRunId, 1);
    await expect(service.rejectWorkflowRevision(second.harnessRunId, 1)).rejects.toThrow("只能拒绝最新未接受且未拒绝草案");
  });

  test("命令目录只按 cwd + runtime 缓存，切换主控 runtime 必须重新发现", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-catalog-cache-")); directories.push(cwd);
    let created = 0;
    let closed = 0;
    class CatalogPi implements HarnessSession {
      isRunning = false;
      readonly availableCommands = [{ name: "$brainstorming", description: "头脑风暴", inputHint: null }];
      subscribe() { return () => {}; }
      async prompt(): Promise<string> { throw new Error("目录会话不发送 prompt"); }
      abort() {}
      close() { closed += 1; }
    }
    const service = new HarnessService(harnessRunsRoot(cwd), async () => { created += 1; return new CatalogPi(); });
    expect((await service.commandCatalog("/workspace", "runtime-a"))[0]?.name).toBe("$brainstorming");
    await service.commandCatalog("/workspace", "runtime-a");
    expect(created).toBe(1);
    await service.commandCatalog("/workspace", "runtime-b");
    expect(created).toBe(2);
    expect(closed).toBe(2);
  });

  test("ACP 命令目录经会话级订阅发布到全局事件，不依赖 prompt 回合订阅", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-commands-")); directories.push(cwd);
    class CommandPi implements HarnessSession {
      #listeners = new Set<(event: HarnessStreamEvent) => void>();
      isRunning = false;
      readonly availableCommands = [
        { name: "$brainstorming", description: "头脑风暴", inputHint: null },
        { name: "status", description: "查看状态", inputHint: null },
      ];
      subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
      async prompt() {
        this.isRunning = true;
        for (const listener of this.#listeners) listener({ type: "commands_changed", commands: [
          { name: "$brainstorming", description: "头脑风暴", inputHint: null },
          { name: "status", description: "查看状态", inputHint: null },
        ] });
        for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "完成" });
        this.isRunning = false;
        return "完成";
      }
      abort() {}
    }
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, () => new CommandPi());
    const events: HarnessStreamEvent[] = [];
    const unsubscribe = service.addEventListener((_id, event) => events.push(event));
    let harnessRunId = "";
    try {
      const created = await service.create(cwd);
      harnessRunId = created.harnessRunId;
      await service.send(created.harnessRunId, "加载命令");
      await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    } finally {
      unsubscribe();
    }
    expect(events.find((event) => event.type === "commands_changed")).toEqual({
      type: "commands_changed",
      commands: [
        { name: "$brainstorming", description: "头脑风暴", inputHint: null },
        { name: "status", description: "查看状态", inputHint: null },
      ],
    });
    // 一次性事件可能被 Web 错过；快照必须带上同一会话的命令目录。
    expect((await service.snapshot(harnessRunId)).availableCommands).toEqual([
      { name: "$brainstorming", description: "头脑风暴", inputHint: null },
      { name: "status", description: "查看状态", inputHint: null },
    ]);
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("Harness turn 未在时限内结束。 "); await Bun.sleep(2); }
}

test("空闲主控会话超过上限时关闭最久未用，下一次回合可从耐久历史重建", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-idle-session-cap-")); directories.push(cwd);
  const root = harnessRunsRoot(cwd);
  const sessions: CapFakePi[] = [];
  const service = new HarnessService(root, async () => { const session = new CapFakePi(); sessions.push(session); return session; }, undefined, undefined, false, 1, 1, 0);
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await service.create(cwd);
    ids.push(created.harnessRunId);
    await service.send(created.harnessRunId, `hello ${index}`);
    for (let wait = 0; wait < 100 && (await service.snapshot(created.harnessRunId)).status === "running"; wait += 1) await Bun.sleep(2);
  }
  expect(sessions.filter(session => session.closed).length).toBeGreaterThanOrEqual(2);
  const before = sessions.length;
  await service.send(ids[0]!, "reopen");
  expect(sessions.length).toBe(before + 1);
});

class CapFakePi implements HarnessSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  closed = false;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(_text: string) { this.isRunning = true; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "answer" }); this.isRunning = false; return "answer"; }
  abort() { this.isRunning = false; }
  close() { this.closed = true; }
}

test("Orca 式空闲窗口到期后关闭未达硬上限的主控会话", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-idle-session-window-")); directories.push(cwd);
  const root = harnessRunsRoot(cwd);
  const sessions: CapFakePi[] = [];
  const service = new HarnessService(root, async () => { const session = new CapFakePi(); sessions.push(session); return session; }, undefined, undefined, false, 3, 20, 0);
  for (let index = 0; index < 2; index += 1) {
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, `hello ${index}`);
    for (let wait = 0; wait < 100 && (await service.snapshot(created.harnessRunId)).status === "running"; wait += 1) await Bun.sleep(2);
  }
  await Bun.sleep(60);
  expect(sessions.some(session => session.closed)).toBe(true);
  service.close();
});
