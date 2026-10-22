import { expect, test } from "bun:test";
import {
  createEngineClient,
  type EngineTransport,
} from "../../src-tauri/web/src/engine-client";

/** 测试用超时边界：默认 20ms，允许 5ms 起，快速触发超时。 */
const FAST_TIMEOUTS = { defaultMs: 20, minMs: 5, maxMs: 1_000 };

/** 等待一个宏任务，让 client 内部的 await 链完成。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function requestIdOf(line: string): string {
  return (JSON.parse(line) as { requestId: string }).requestId;
}

/** 可编程的假 transport：手动触发响应/退出/订阅失败。 */
function fakeTransport() {
  let lineHandler: ((line: string) => void) | null = null;
  let exitHandler: ((generation: number) => void) | null = null;
  let generation = 1;
  let lineSubscriptions = 0;
  let exitSubscriptions = 0;
  let failNextLineSubscription = false;
  const writes: string[] = [];
  const transport: EngineTransport = {
    async write(line) {
      writes.push(line);
      return generation;
    },
    async subscribeLine(handler) {
      lineSubscriptions += 1;
      if (failNextLineSubscription) {
        failNextLineSubscription = false;
        throw new Error("listen failed");
      }
      lineHandler = handler;
      return () => {
        lineHandler = null;
      };
    },
    async subscribeExit(handler) {
      exitSubscriptions += 1;
      exitHandler = handler;
      return () => {
        exitHandler = null;
      };
    },
  };
  return {
    transport,
    writes,
    setGeneration(value: number) {
      generation = value;
    },
    emitResponse(
      requestId: string,
      outcome: { result?: unknown } | { error: string },
    ) {
      const frame =
        "error" in outcome
          ? { requestId, ok: false, error: outcome.error }
          : { requestId, ok: true, result: outcome.result };
      lineHandler?.(JSON.stringify(frame));
    },
    emitExit(value: number) {
      exitHandler?.(value);
    },
    failNextLineSubscription() {
      failNextLineSubscription = true;
    },
    subscriptions() {
      return { lineSubscriptions, exitSubscriptions };
    },
  };
}

test("正常响应按 requestId 配对；重复响应被忽略", async () => {
  const fake = fakeTransport();
  const client = createEngineClient(fake.transport, FAST_TIMEOUTS);
  const pending = client.action<{ value: number }>("demo", { a: 1 });
  await flush();
  expect(fake.writes).toHaveLength(1);
  expect(JSON.parse(fake.writes[0]!).action).toBe("demo");

  const requestId = requestIdOf(fake.writes[0]!);
  fake.emitResponse(requestId, { result: { value: 7 } });
  fake.emitResponse(requestId, { result: { value: 99 } });
  expect(await pending).toEqual({ value: 7 });
  expect(client.pendingCount()).toBe(0);
});

test("错误响应转成 Error；超时后迟到响应不影响后续请求", async () => {
  const fake = fakeTransport();
  const client = createEngineClient(fake.transport, {
    defaultMs: 5,
    minMs: 5,
    maxMs: 50,
  });

  const failed = client.action("boom");
  await flush();
  fake.emitResponse(requestIdOf(fake.writes[0]!), { error: "engine 拒绝" });
  await expect(failed).rejects.toThrow("engine 拒绝");

  const timedOut = client.action("slow");
  await expect(timedOut).rejects.toThrow("超时");
  expect(client.pendingCount()).toBe(0);

  // 超时请求的迟到响应必须被丢弃，不能污染下一个请求。
  fake.emitResponse(requestIdOf(fake.writes[1]!), { result: { late: true } });
  const next = client.action<{ ok: boolean }>("next");
  await flush();
  fake.emitResponse(requestIdOf(fake.writes[2]!), { result: { ok: true } });
  expect(await next).toEqual({ ok: true });
});

test("engine-exited 只拒绝旧 generation 的请求，新 Engine 在途请求继续等待", async () => {
  const fake = fakeTransport();
  const client = createEngineClient(fake.transport, FAST_TIMEOUTS);

  const oldRequest = client.action("old");
  await flush();
  fake.setGeneration(2);
  const newRequest = client.action("new");
  await flush();

  fake.emitExit(1);
  await expect(oldRequest).rejects.toThrow("已退出");
  expect(client.pendingCount()).toBe(1);

  fake.emitResponse(requestIdOf(fake.writes[1]!), { result: { fresh: true } });
  expect(await newRequest).toEqual({ fresh: true });
});

test("写入返回前发生 engine-exited：写入完成后立即拒绝，不等超时", async () => {
  const fake = fakeTransport();
  let releaseWrite: ((generation: number) => void) | null = null;
  const transport: EngineTransport = {
    ...fake.transport,
    write(line) {
      fake.writes.push(line);
      return new Promise<number>((resolve) => {
        releaseWrite = resolve;
      });
    },
  };
  const client = createEngineClient(transport, {
    defaultMs: 500,
    minMs: 500,
    maxMs: 500,
  });

  const pending = client.action("racy");
  await flush();
  fake.emitExit(1);
  // generation 尚未回填，不能立刻拒绝；写入完成后按 exitedThrough 补判。
  expect(client.pendingCount()).toBe(1);
  releaseWrite!(1);
  await expect(pending).rejects.toThrow("已退出");
  expect(client.pendingCount()).toBe(0);
});

test("监听注册失败后下次 action 可重试，且不会重复订阅", async () => {
  const fake = fakeTransport();
  const client = createEngineClient(fake.transport, FAST_TIMEOUTS);

  fake.failNextLineSubscription();
  await expect(client.action("first")).rejects.toThrow("listen failed");
  expect(fake.writes).toHaveLength(0);

  const pending = client.action<{ ok: boolean }>("second");
  await flush();
  fake.emitResponse(requestIdOf(fake.writes[0]!), { result: { ok: true } });
  expect(await pending).toEqual({ ok: true });
  expect(fake.subscriptions()).toEqual({
    lineSubscriptions: 2,
    exitSubscriptions: 1,
  });
});
