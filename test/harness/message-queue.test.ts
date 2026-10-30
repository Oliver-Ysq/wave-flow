import { afterEach, describe, expect, test } from "bun:test";
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

/** 完全受控的主控会话：prompt 挂起直到测试显式 finish/fail；abort 不解决 promise，模拟无响应 provider。 */
class ControllableSession implements HarnessSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  #resolve: ((value: string) => void) | null = null;
  #reject: ((error: Error) => void) | null = null;
  isRunning = false;
  closed = false;
  aborted = false;
  readonly prompts: string[] = [];
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  prompt(text: string): Promise<string> {
    this.prompts.push(text);
    this.isRunning = true;
    return new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }
  finish(text = "durable answer") { this.isRunning = false; for (const listener of this.#listeners) listener({ type: "assistant_delta", delta: text }); this.#resolve?.(text); this.#resolve = null; this.#reject = null; }
  fail(error: Error) { this.isRunning = false; this.#reject?.(error); this.#resolve = null; this.#reject = null; }
  abort() { this.aborted = true; this.isRunning = false; }
  close() { this.closed = true; }
}

type Rig = { service: HarnessService; sessions: ControllableSession[]; root: string; events: HarnessStreamEvent[] };

async function makeRig(): Promise<Rig> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-queue-"));
  directories.push(cwd);
  const root = harnessRunsRoot(cwd);
  const sessions: ControllableSession[] = [];
  const events: HarnessStreamEvent[] = [];
  const service = new HarnessService(root, async () => { const session = new ControllableSession(); sessions.push(session); return session; });
  service.addEventListener((_id, event) => events.push(event));
  const created = await service.create(cwd);
  return { service, sessions, root, events, ...{ harnessRunId: created.harnessRunId } } as Rig & { harnessRunId: string };
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

describe("Harness 耐久消息队列", () => {
  test("忙碌时普通消息耐久入队，回合结束后按 FIFO 自动投递", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    expect(sessions).toHaveLength(1);
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");

    const queued1 = await service.submit(harnessRunId, "second", { clientMessageId: crypto.randomUUID() });
    expect(queued1.status).toBe("running");
    expect(queued1.messageQueue.map((item) => item.message.text)).toEqual(["second"]);
    expect(queued1.messages.map((message) => message.text)).toEqual(["first"]);
    const queued2 = await service.submit(harnessRunId, "third");
    expect(queued2.messageQueue.map((item) => item.message.text)).toEqual(["second", "third"]);
    expect(rig.events.some((event) => event.type === "queue_changed")).toBe(true);

    sessions[0]!.finish("answer-1");
    await waitFor(() => sessions[0]!.prompts.length === 2, "第二条消息自动投递");
    expect(sessions[0]!.prompts[1]).toBe("second");
    sessions[0]!.finish("answer-2");
    await waitFor(() => sessions[0]!.prompts.length === 3, "第三条消息自动投递");
    expect(sessions[0]!.prompts[2]).toBe("third");
    sessions[0]!.finish("answer-3");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle" && (await service.snapshot(harnessRunId)).messages.length === 6, "全部回合收敛");

    const snapshot = await service.snapshot(harnessRunId);
    expect(snapshot.messageQueue).toEqual([]);
    expect(snapshot.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      "user:first", "assistant:answer-1", "user:second", "assistant:answer-2", "user:third", "assistant:answer-3",
    ]);
    // 队列事实与回放一致。
    const opened = await HarnessJournal.open(harnessRunId, rig.root);
    expect(opened.events.filter((event) => event.type === "harness.message_queued")).toHaveLength(2);
    expect(opened.events.filter((event) => event.type === "harness.message_dispatched")).toHaveLength(2);
  });

  test("立即发送先耐久中断原因并关闭旧会话，再优先投递；迟到回答被丢弃", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");

    const snapshot = await service.submit(harnessRunId, "urgent", { immediate: true, clientMessageId: crypto.randomUUID() });
    await waitFor(() => sessions.length === 2 && sessions[1]!.prompts.length === 1, "优先消息经新会话投递");
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[1]!.prompts[0]).toBe("urgent");
    expect(snapshot.messages.at(-1)?.text).toBe("urgent");
    expect(snapshot.messageQueue).toEqual([]);

    const opened = await HarnessJournal.open(harnessRunId, rig.root);
    const kinds = opened.events.map((event) => event.type);
    // 顺序：原回合 → 优先消息入队 → 中断落盘 → 原子派发 → 新回合。
    expect(kinds).toEqual([
      "harness.created", "harness.user_message", "harness.turn_started",
      "harness.message_queued", "harness.turn_interrupted",
      "harness.message_dispatched", "harness.turn_started",
    ]);
    const interrupted = opened.events.find((event) => event.type === "harness.turn_interrupted");
    expect(interrupted && "diagnostic" in interrupted ? interrupted.diagnostic : "").toContain("立即发送");

    // 旧会话迟到 resolve：不能追加 assistant 消息或第二条中断事实。
    sessions[0]!.finish("late answer");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await HarnessJournal.open(harnessRunId, rig.root);
    expect(after.events.filter((event) => event.type === "harness.assistant_message")).toHaveLength(0);
    expect(after.events.filter((event) => event.type === "harness.turn_interrupted")).toHaveLength(1);

    sessions[1]!.finish("urgent answer");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle", "优先回合收敛");
    const finalSnapshot = await service.snapshot(harnessRunId);
    expect(finalSnapshot.messages.map((message) => message.text)).toEqual(["first", "urgent", "urgent answer"]);
  });

  test("高优先级按入队序优先，普通消息不被越过且保持 FIFO", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");
    await service.submit(harnessRunId, "normal-1");
    await service.submit(harnessRunId, "urgent-1", { immediate: true });
    await waitFor(() => sessions.length === 2 && sessions[1]!.prompts.length === 1, "urgent-1 优先投递");
    expect(sessions[1]!.prompts[0]).toBe("urgent-1");

    await service.submit(harnessRunId, "normal-2");
    await service.submit(harnessRunId, "urgent-2", { immediate: true });
    await waitFor(() => sessions.length === 3 && sessions[2]!.prompts.length === 1, "urgent-2 再次插队");
    expect(sessions[2]!.prompts[0]).toBe("urgent-2");

    sessions[2]!.finish("answer-u2");
    await waitFor(() => sessions[2]!.prompts.length === 2, "normal-1 恢复投递");
    expect(sessions[2]!.prompts[1]).toBe("normal-1");
    sessions[2]!.finish("answer-n1");
    await waitFor(() => sessions[2]!.prompts.length === 3, "normal-2 按序投递");
    expect(sessions[2]!.prompts[2]).toBe("normal-2");
    sessions[2]!.finish("answer-n2");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle", "全部收敛");

    // 被插队打断的 urgent-1 迟到完成，不改变任何事实。
    sessions[1]!.finish("late urgent-1");
    sessions[0]!.finish("late first");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalSnapshot = await service.snapshot(harnessRunId);
    expect(finalSnapshot.messages.map((message) => message.text)).toEqual([
      "first", "urgent-1", "urgent-2", "answer-u2", "normal-1", "answer-n1", "normal-2", "answer-n2",
    ]);
    const opened = await HarnessJournal.open(harnessRunId, rig.root);
    expect(opened.events.filter((event) => event.type === "harness.turn_interrupted")).toHaveLength(2);
  });

  test("重复 clientMessageId 幂等：不重复入队、不重复开回合", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");
    const clientMessageId = crypto.randomUUID();
    const first = await service.submit(harnessRunId, "dup", { clientMessageId });
    const second = await service.submit(harnessRunId, "dup", { clientMessageId });
    expect(second.messageQueue).toHaveLength(1);
    expect(second.messageQueue[0]!.message.id).toBe(first.messageQueue[0]!.message.id);
    sessions[0]!.finish("answer");
    await waitFor(() => sessions[0]!.prompts.length === 2, "幂等消息按队列投递");
    expect(sessions[0]!.prompts).toEqual(["first", "dup"]);
    sessions[0]!.finish("answer-2");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle" && (await service.snapshot(harnessRunId)).messages.length === 4, "全部回合收敛");
    // 已投递后同 id 重试仍是幂等返回，不新增任何消息。
    const again = await service.submit(harnessRunId, "dup", { clientMessageId });
    expect(again.messages.filter((message) => message.id === clientMessageId)).toHaveLength(1);
    expect(sessions[0]!.prompts).toEqual(["first", "dup"]);
  });

  test("用户在投递前取消排队；已派发或未知消息拒绝且零写入", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");
    const queued = await service.submit(harnessRunId, "drop-me");
    await service.submit(harnessRunId, "keep-me");
    const cancelled = await service.cancelQueued(harnessRunId, queued.messageQueue[0]!.message.id);
    expect(cancelled.messageQueue.map((item) => item.message.text)).toEqual(["keep-me"]);
    await expect(service.cancelQueued(harnessRunId, queued.messageQueue[0]!.message.id)).rejects.toThrow("已投递或不在队列中");
    await expect(service.cancelQueued(harnessRunId, crypto.randomUUID())).rejects.toThrow("已投递或不在队列中");

    sessions[0]!.finish("answer");
    await waitFor(() => sessions[0]!.prompts.length === 2, "保留消息按队列投递");
    expect(sessions[0]!.prompts).toEqual(["first", "keep-me"]);
    sessions[0]!.finish("answer-2");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle", "全部回合收敛");
    expect(sessions[0]!.prompts).toEqual(["first", "keep-me"]);
    const opened = await HarnessJournal.open(harnessRunId, rig.root);
    expect(opened.events.filter((event) => event.type === "harness.message_cancelled")).toHaveLength(1);
    expect(opened.events.filter((event) => event.type === "harness.message_dispatched")).toHaveLength(1);
  });

  test("Engine 重启不丢失队列，收敛旧回合后恢复从未投递的消息", async () => {
    const rig = await makeRig();
    const { service, sessions, root } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");
    await service.submit(harnessRunId, "queued-1");
    await service.submit(harnessRunId, "queued-2");

    // 模拟 Engine 重启：全新服务实例，旧回合永不 resolve。
    const restarted: ControllableSession[] = [];
    const service2 = new HarnessService(root, async () => { const session = new ControllableSession(); restarted.push(session); return session; });
    await service2.convergeStaleTurns();
    const converged = await service2.snapshot(harnessRunId);
    expect(converged.status).toBe("interrupted");
    expect(converged.messageQueue.map((item) => item.message.text)).toEqual(["queued-1", "queued-2"]);

    await service2.resumeMessageQueues();
    await waitFor(() => restarted.length === 1 && restarted[0]!.prompts.length === 1, "重启后队首投递");
    expect(restarted[0]!.prompts[0]).toBe("queued-1");
    restarted[0]!.finish("answer-1");
    await waitFor(() => restarted[0]!.prompts.length === 2, "第二条按序投递");
    expect(restarted[0]!.prompts[1]).toBe("queued-2");
    restarted[0]!.finish("answer-2");
    await waitFor(async () => (await service2.snapshot(harnessRunId)).status === "idle", "全部收敛");

    const opened = await HarnessJournal.open(harnessRunId, root);
    expect(opened.events.filter((event) => event.type === "harness.turn_interrupted")).toHaveLength(1);
    expect(opened.events.filter((event) => event.type === "harness.assistant_message")).toHaveLength(2);
  });

  test("用户停止保持队列不自动派发；再次发送后按 FIFO 恢复", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");
    await service.submit(harnessRunId, "queued");
    await service.abort(harnessRunId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const held = await service.snapshot(harnessRunId);
    expect(held.status).toBe("interrupted");
    expect(held.messageQueue.map((item) => item.message.text)).toEqual(["queued"]);
    expect(sessions[0]!.prompts).toEqual(["first"]);

    await service.submit(harnessRunId, "after-stop");
    await waitFor(() => sessions.length === 2 && sessions[1]!.prompts.length === 1, "队列恢复投递");
    expect(sessions[1]!.prompts[0]).toBe("queued");
    sessions[1]!.finish("answer-1");
    await waitFor(() => sessions[1]!.prompts.length === 2, "新消息按序投递");
    expect(sessions[1]!.prompts[1]).toBe("after-stop");
    sessions[1]!.finish("answer-2");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle", "全部收敛");
  });

  test("回合投递失败不自动重发：队列保持，用户继续后恢复", async () => {
    const rig = await makeRig();
    const { service, sessions } = rig;
    const harnessRunId = (await service.list())[0]!.harnessRunId;
    await service.submit(harnessRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");
    await service.submit(harnessRunId, "queued");
    sessions[0]!.fail(new Error("provider disconnected"));
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "interrupted", "回合中断收敛");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const held = await service.snapshot(harnessRunId);
    expect(held.messageQueue.map((item) => item.message.text)).toEqual(["queued"]);
    expect(sessions[0]!.prompts).toEqual(["first"]);

    await service.submit(harnessRunId, "continue");
    await waitFor(() => sessions.length === 2 && sessions[1]!.prompts.length === 1, "队列恢复");
    expect(sessions[1]!.prompts[0]).toBe("queued");
    sessions[1]!.finish("answer-1");
    await waitFor(() => sessions[1]!.prompts.length === 2, "后续按序");
    expect(sessions[1]!.prompts[1]).toBe("continue");
    sessions[1]!.finish("answer-2");
    await waitFor(async () => (await service.snapshot(harnessRunId)).status === "idle", "全部收敛");
  });
});

/**
 * 回合收敛写入本身失败时（例如状态目录被删除、写盘错误），`entry.turn` 的契约是
 * "内部捕获全部异常、调用方按耐久快照判断结果"。收尾失败不得把该 promise 变成
 * 无人观察的 rejection：普通路径没人 await 它，那会放大成进程级 unhandled rejection。
 * 现场由下次启动的 convergeStaleTurns 收敛，这里只允许出现内存态诊断。
 */
describe("Harness 回合异常收尾的失败边界", () => {
  test("状态目录已消失时收尾失败只产生内存诊断，不抛出未观察 rejection", async () => {
    const rig = await makeRig();
    const harnessRunId = (rig as unknown as { harnessRunId: string }).harnessRunId;
    await rig.service.submit(harnessRunId, "第一条");
    await waitFor(() => rig.sessions.length === 1 && rig.sessions[0]!.prompts.length === 1, "首个回合开始");
    // 让 catch 分支的耐久收尾必然失败：删掉该会话的档案目录。
    await rm(join(rig.root, harnessRunId), { recursive: true, force: true });
    rig.sessions[0]!.fail(new Error("provider 断线"));
    await waitFor(() => rig.events.some((event) => event.type === "turn_interrupted" && (event.diagnostic ?? "").includes("收尾失败")), "收尾失败诊断");
    const diagnostic = rig.events.find((event) => event.type === "turn_interrupted" && (event.diagnostic ?? "").includes("收尾失败"))!;
    // 原始失败原因与收尾失败原因都要保留，否则用户看不到回合为什么结束。
    expect(diagnostic.type === "turn_interrupted" ? diagnostic.diagnostic : "").toContain("provider 断线");
    rig.service.close();
  });
});
