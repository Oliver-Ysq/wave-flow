import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessService } from "../../src/harness/service";
import type { HarnessPiSession } from "../../src/harness/pi-harness";
import type { HarnessStreamEvent } from "../../src/harness/types";
import { harnessRunsRoot } from "../../src/journal/paths";

const testModel = { model: "test", baseUrl: "https://example.test/v1", apiKey: "test-key" };

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class FakePi implements HarnessPiSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(text: string) { this.isRunning = true; for (const listener of this.#listeners) { listener({ type: "reasoning_delta", delta: `<think>${text}</think>` }); listener({ type: "assistant_delta", delta: "durable answer" }); } this.isRunning = false; return "durable answer"; }
  abort() { this.isRunning = false; }
}

class InterruptedPi implements HarnessPiSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(_text: string): Promise<string> { this.isRunning = true; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: "partial text" }); this.isRunning = false; throw new Error("provider disconnected"); }
  abort() { this.isRunning = false; }
}

class EmptyPi implements HarnessPiSession {
  isRunning = false;
  subscribe(_listener: (event: HarnessStreamEvent) => void) { return () => {}; }
  async prompt(_text: string): Promise<string> { return ""; }
  abort() { this.isRunning = false; }
}

class UnverifiedProjectPi implements HarnessPiSession {
  isRunning = false;
  subscribe(_listener: (event: HarnessStreamEvent) => void) { return () => {}; }
  async prompt(_text: string): Promise<string> { throw new Error("主控未执行任何已验证只读工具，拒绝耐久项目事实结论。 "); }
  abort() { this.isRunning = false; }
}

class DeferredPi implements HarnessPiSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  #resolve: ((value: string) => void) | null = null;
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  prompt(_text: string): Promise<string> { this.isRunning = true; return new Promise(resolve => { this.#resolve = resolve; }); }
  finish() { this.isRunning = false; this.#resolve?.("finished"); }
  abort() { this.isRunning = false; this.#resolve?.(""); }
}

describe("HarnessService", () => {
  test("reasoning 只流式展示，完整 assistant 回答才耐久", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-service-")); directories.push(cwd);
    const service = new HarnessService(harnessRunsRoot(cwd), async () => testModel, (_config, _cwd, _prior) => new FakePi());
    const created = await service.create(cwd);
    const events: HarnessStreamEvent[] = [];
    await service.subscribe(created.harnessRunId, (event) => events.push(event));
    await service.send(created.harnessRunId, "hello");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    expect(events).toEqual(expect.arrayContaining([{ type: "reasoning_delta", delta: "<think>hello</think>" }, { type: "assistant_delta", delta: "durable answer" }]));
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ status: "idle", messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "durable answer" }] });
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
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ messages: [{ role: "user", text: "hello" }], diagnostic: "Pi 主控回答只包含非持久 reasoning。 " });
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
    const source = 'export const meta = { name: "draft", description: "draft", phases: [{ title: "plan" }] };\nexport default async function run() {}';
    const proposed = await service.proposeWorkflowRevision(created.harnessRunId, source);
    expect(proposed.workflowRevisions).toHaveLength(1);
    expect(proposed.workflowRevisions[0]).toMatchObject({ revision: 1, source, acceptedAt: null, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(service.acceptWorkflowRevision(created.harnessRunId, 1)).resolves.toMatchObject({ workflowRevisions: [{ revision: 1, acceptedAt: expect.any(String) }] });
    await expect(service.acceptWorkflowRevision(created.harnessRunId, 1)).rejects.toThrow("最新未接受草案");
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
    await Promise.all([service.proposeWorkflowRevision(created.harnessRunId, "one"), service.proposeWorkflowRevision(created.harnessRunId, "two")]);
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ workflowRevisions: [{ revision: 1 }, { revision: 2 }] });
  });

  test("当前主控回合可经窄工具耐久草案，用户 API 仍不得在运行中抢写", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-action-revision-")); directories.push(cwd);
    let actions: import("../../src/harness/action-tools").HarnessActionCallbacks | null = null;
    let running = false;
    const pi: HarnessPiSession = {
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
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) { if (Date.now() >= deadline) throw new Error("Harness turn 未在时限内结束。 "); await Bun.sleep(2); }
}
