import { expect, test } from "bun:test";
import { createLatestRequestGuard, runGuarded } from "../../src-tauri/web/src/local-workflow-preview";

/** 可控 promise：手动决定 resolve/reject 时机。 */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function recorder<T>() {
  const calls: string[] = [];
  return {
    calls,
    sinks: { onResult: (value: T) => void calls.push(`result:${String(value)}`), onError: (cause: unknown) => void calls.push(`error:${String(cause)}`), onSettled: () => void calls.push("settled") },
  };
}

test("路径变化使在途预检失效：旧响应不能复活结果，finally 也不污染新路径", async () => {
  const guard = createLatestRequestGuard();
  const tokenA = guard.begin();
  const requestA = deferred<string>();
  const a = recorder<string>();
  const pending = runGuarded(guard, tokenA, () => requestA.promise, a.sinks);
  guard.invalidate();
  requestA.resolve("预检A结果");
  await pending;
  expect(a.calls).toEqual([]);
});

test("失效请求的错误与收尾同样静默", async () => {
  const guard = createLatestRequestGuard();
  const tokenA = guard.begin();
  const requestA = deferred<string>();
  const a = recorder<string>();
  const pending = runGuarded(guard, tokenA, () => requestA.promise, a.sinks);
  guard.invalidate();
  requestA.reject(new Error("预检A失败"));
  await pending;
  expect(a.calls).toEqual([]);
});

test("新令牌的响应正常交付，随后旧请求迟到仍被忽略", async () => {
  const guard = createLatestRequestGuard();
  const tokenA = guard.begin();
  const requestA = deferred<string>();
  const a = recorder<string>();
  const pendingA = runGuarded(guard, tokenA, () => requestA.promise, a.sinks);
  const tokenB = guard.begin();
  const requestB = deferred<string>();
  const b = recorder<string>();
  const pendingB = runGuarded(guard, tokenB, () => requestB.promise, b.sinks);
  requestB.resolve("预检B结果");
  await pendingB;
  expect(b.calls).toEqual(["result:预检B结果", "settled"]);
  requestA.resolve("预检A结果");
  await pendingA;
  expect(a.calls).toEqual([]);
  expect(b.calls).toEqual(["result:预检B结果", "settled"]);
});

test("未失效的请求错误与收尾照常交付", async () => {
  const guard = createLatestRequestGuard();
  const token = guard.begin();
  const request = deferred<string>();
  const r = recorder<string>();
  const pending = runGuarded(guard, token, () => request.promise, r.sinks);
  request.reject(new Error("找不到文件"));
  await pending;
  expect(r.calls).toEqual(["error:Error: 找不到文件", "settled"]);
});

test("组件里路径输入与文件选择都经 changePath 立即使旧令牌失效", async () => {
  const source = await Bun.file("src-tauri/web/src/local-workflow-preview.tsx").text();
  expect(source).toContain("const changePath=(value:string)=>{guard.invalidate();");
  expect(source).toContain("onChange={event=>changePath(event.target.value)}");
  expect(source).toContain("if(typeof selected===\"string\")changePath(selected);");
  expect(source).toContain("onClose={()=>{guard.invalidate();onClose();}}");
});
