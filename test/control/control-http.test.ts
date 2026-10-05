import { describe, expect, test } from "bun:test";
import { handleCompleteHttp } from "../../src/control/control-http";
import { handleAnswerHttp, handleBlockHttp, handleContinueHttp } from "../../src/control/block-http";

describe("Control complete HTTP", () => {
  test("拒绝错误方法、content-type 与非对象结果", async () => {
    const control = { complete: async () => {} } as never;
    expect((await handleCompleteHttp(control, new Request("http://127.0.0.1/control/complete"))).status).toBe(405);
    expect((await handleCompleteHttp(control, new Request("http://127.0.0.1/control/complete", { method: "POST" }))).status).toBe(415);
    const response = await handleCompleteHttp(control, new Request("http://127.0.0.1/control/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: [] }) }));
    expect(response.status).toBe(400);
  });
});

describe("Control block HTTP", () => {
  test("拒绝错误方法、content-type 和不完整的 block / continue 请求", async () => {
    const control = { block: async () => ({ blockRequestId: crypto.randomUUID(), answer: {} }), answer: async () => {}, continue: async () => {} } as never;
    expect((await handleBlockHttp(control, new Request("http://127.0.0.1/control/block"))).status).toBe(405);
    expect((await handleBlockHttp(control, new Request("http://127.0.0.1/control/block", { method: "POST" }))).status).toBe(400);
    const invalidBlock = await handleBlockHttp(control, new Request("http://127.0.0.1/control/block", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ needHelp: "x" }) }));
    expect(invalidBlock.status).toBe(400);
    const invalidAnswer = await handleAnswerHttp(control, crypto.randomUUID(), new Request("http://127.0.0.1/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: [] }) }));
    expect(invalidAnswer.status).toBe(400);
    const invalidContinue = await handleContinueHttp(control, new Request("http://127.0.0.1/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
    expect(invalidContinue.status).toBe(400);
  });
});
