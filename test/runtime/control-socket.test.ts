import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { connectControlSocket, startControlSocket, type ControlSocketServer } from "../../src/runtime/control-socket";

const servers: ControlSocketServer[] = [];
const roots: string[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/**
 * 回归：Bun 的 socket.write 单次最多接受 8192 字节，其余必须靠 drain 续写。
 * 曾经的实现直接丢弃剩余字节，导致 >8KiB 的响应被截断、对端永远等不到完整的一行
 * （实测 read_run_capsule 的 24KB 响应只到达 8192B，MCP 调用悬空到超时）。
 */
test("超过 8KiB 的响应完整送达客户端", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctl-big-resp-")); roots.push(root);
  const payload = "中".repeat(9000); // ≈27KB UTF-8
  const server = startControlSocket({
    root, prefix: "ctl-",
    onLine: (line, reply) => { const requestId = (JSON.parse(line) as { requestId: string }).requestId; reply(JSON.stringify({ requestId, ok: true, result: { echo: line, payload } })); },
  });
  servers.push(server);
  const client = await connectControlSocket({ socketPath: server.socketPath, idPrefix: "t" });
  const result = await client.request({ probe: "x" }) as { echo: string; payload: string };
  expect(result.echo).toContain("probe");
  expect(result.payload.length).toBe(payload.length);
  expect(result.payload).toBe(payload);
  client.close();
});

test("超过 8KiB 的请求完整送达服务端", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctl-big-req-")); roots.push(root);
  const received: string[] = [];
  const server = startControlSocket({
    root, prefix: "ctl-",
    onLine: (line, reply) => { received.push(line); const requestId = (JSON.parse(line) as { requestId: string }).requestId; reply(JSON.stringify({ requestId, ok: true, result: { ok: true } })); },
  });
  servers.push(server);
  const client = await connectControlSocket({ socketPath: server.socketPath, idPrefix: "t" });
  const big = "文".repeat(9000); // ≈27KB UTF-8
  await client.request({ action: "probe", text: big });
  expect(received).toHaveLength(1);
  const parsed = JSON.parse(received[0]!) as { text: string };
  expect(parsed.text.length).toBe(big.length);
  expect(parsed.text).toBe(big);
  client.close();
});

/**
 * 关闭不得截断正在写回的大响应：执行器在 complete 后立刻收尾时，写队列里可能还有
 * 未刷出的字节。close 必须先等在途请求写完并排空写队列，再结束连接。
 */
test("回复后立即关闭通道，大响应仍完整送达", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctl-close-")); roots.push(root);
  const payload = "中".repeat(9000);
  let channel!: ControlSocketServer;
  channel = startControlSocket({
    root, prefix: "ctl-",
    onLine: (line, reply) => {
      const requestId = (JSON.parse(line) as { requestId: string }).requestId;
      reply(JSON.stringify({ requestId, ok: true, result: { payload } }));
      // 最坏时序：响应刚入写队列就要求关闭通道
      channel.close();
    },
  });
  servers.push(channel);
  const client = await connectControlSocket({ socketPath: channel.socketPath, idPrefix: "t" });
  const result = await client.request({ probe: "x" }) as { payload: string };
  expect(result.payload.length).toBe(payload.length);
  client.close();
});

/**
 * 同一连接上的并发大响应不能互相覆盖：写队列必须把新帧接在未写完的字节之后。
 * 旧实现用新帧的剩余字节覆盖队列，前一个响应的尾部会被丢掉。
 */
test("并发大响应按序完整送达，互不覆盖", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctl-concurrent-")); roots.push(root);
  const server = startControlSocket({
    root, prefix: "ctl-",
    onLine: (line, reply) => {
      const request = JSON.parse(line) as { requestId: string; index: number };
      const payload = `${request.index}:`.padEnd(12, "-") + "中".repeat(6000); // ≈18KB UTF-8
      reply(JSON.stringify({ requestId: request.requestId, ok: true, result: { payload } }));
    },
  });
  servers.push(server);
  const client = await connectControlSocket({ socketPath: server.socketPath, idPrefix: "t" });
  const [first, second] = await Promise.all([
    client.request({ index: 1 }) as Promise<{ payload: string }>,
    client.request({ index: 2 }) as Promise<{ payload: string }>,
  ]);
  expect(first.payload.startsWith("1:")).toBe(true);
  expect(second.payload.startsWith("2:")).toBe(true);
  expect(first.payload.length).toBe(second.payload.length);
  client.close();
});
