import { describe, expect, test } from "bun:test";
import { handleCompleteHttp } from "../../src/control/control-http";

describe("Control complete HTTP", () => {
  test("拒绝错误方法、content-type 与非对象结果", async () => {
    const control = { complete: async () => {} } as never;
    expect((await handleCompleteHttp(control, new Request("http://127.0.0.1/control/complete"))).status).toBe(405);
    expect((await handleCompleteHttp(control, new Request("http://127.0.0.1/control/complete", { method: "POST" }))).status).toBe(415);
    const response = await handleCompleteHttp(control, new Request("http://127.0.0.1/control/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: [] }) }));
    expect(response.status).toBe(400);
  });
});
