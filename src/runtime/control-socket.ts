import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";

/**
 * Engine 与私有 MCP sidecar 之间的控制通道：0700 私有目录内的 Unix domain socket。
 *
 * 为什么不是 FIFO：FIFO 的阻塞读由线程池执行，一个长期打开的读会占用一个池线程；
 * 会话结束后关闭 fd 并不能中断另一个线程里已阻塞的 read，线程累积到池大小（=CPU 核数）
 * 后，所有异步文件写入（Journal、日志、节点结果）都会排队永不完成，表现为节点永久
 * running 且无任何日志。Unix socket 的读写由事件循环驱动，不占线程池。
 *
 * 边界不变：不监听网络端口，socket 路径只存在于 Engine 的私有 scratch 目录，不出现在
 * descriptor、Journal、Web、用户配置或日志中；路径本身不构成授权，请求仍带 capability，
 * 由 Control 复核身份与节点状态。
 */

/**
 * Bun 的 socket.write 单次最多接受 8192 字节，其余字节直接丢弃（返回值为实际接受量）。
 * 因此必须缓存剩余部分并在 drain 回调里续写，否则超过 8KiB 的帧会被截断，对端永远
 * 等不到完整的一行（实测：24KB 的 read_run_capsule 响应只收到 8192B，调用悬空）。
 */
const pendingWrites = new Map<Socket, Buffer>();
function writeFrame(socket: Socket, text: string): void {
  const data = Buffer.from(`${text}\n`, "utf8");
  // 同一连接可能有多个响应排队：新帧必须接在未写完的字节之后，不能覆盖它们，
  // 否则并发请求下前一个响应的尾部会被丢弃。
  const queued = pendingWrites.get(socket);
  const combined = queued ? Buffer.concat([queued, data]) : data;
  const accepted = socket.write(combined);
  if (accepted >= combined.length) pendingWrites.delete(socket);
  else pendingWrites.set(socket, combined.subarray(Math.max(0, accepted)));
  // 立刻把已接受的字节推给内核：执行器在 complete 后可能马上关闭通道。
  try { socket.flush(); } catch { /* 连接已关闭 */ }
}
function continueWrite(socket: Socket): void {
  const rest = pendingWrites.get(socket);
  if (!rest) return;
  const accepted = socket.write(rest);
  if (accepted >= rest.length) pendingWrites.delete(socket);
  else pendingWrites.set(socket, rest.subarray(Math.max(0, accepted)));
  try { socket.flush(); } catch { /* 连接已关闭 */ }
}
const hasPendingWrite = (socket: Socket): boolean => pendingWrites.has(socket);

/** Engine 侧的控制通道；close 后路径不可用且目录被删除。 */
export type ControlSocketServer = {
  /** 注入 sidecar 的 socket 绝对路径。 */
  readonly socketPath: string;
  /** 停止接受连接、关闭现有连接并删除私有目录；幂等。 */
  close(): void;
};

/** 一行请求的处理结果；reply 写回同一连接，finish 以 FIN 结束该连接。 */
export type ControlSocketHandler = (
  line: string,
  reply: (line: string) => void,
  finish: () => void,
) => void | Promise<void>;

/** 启动私有控制 socket；每条连接按行切分 JSON，单连接协议错误不改变通道状态。 */
export function startControlSocket(options: {
  /** Engine 私有 scratch 根；通道目录在其下随机创建。 */
  readonly root: string;
  /** 目录前缀，便于区分 Worker 与 Lead 通道。 */
  readonly prefix: string;
  /** 逐行处理请求；返回的 Promise 失败只影响该请求。 */
  readonly onLine: ControlSocketHandler;
  /** 单条连接关闭时回调；用于通道级别的收尾。 */
  readonly onConnectionClosed?: () => void;
}): ControlSocketServer {
  const directory = mkdtempSync(join(options.root, options.prefix));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "control.sock");
  const buffers = new Map<Socket, Buffer>();
  const connections = new Set<Socket>();
  /** 在途请求：close 必须等它们把响应写完，否则 complete 的 ack 会被丢掉。 */
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  let tornDown = false;
  /** 收尾只做一次：停止监听、关闭残留连接并删除私有目录。 */
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    try { server.stop(true); } catch { /* 已停止 */ }
    rmSync(directory, { recursive: true, force: true });
  };
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        connections.add(socket);
        buffers.set(socket, Buffer.alloc(0));
      },
      data(socket, data) {
        // 收尾开始后不再接受新请求；已在处理中的请求仍可写回响应。
        if (closing) return;
        // 按字节切分再解码，避免多字节 UTF-8 字符被分片截断。
        let combined = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), Buffer.from(data)]);
        let index = combined.indexOf(0x0a);
        while (index >= 0) {
          const line = combined.subarray(0, index).toString("utf8");
          combined = combined.subarray(index + 1);
          index = combined.indexOf(0x0a);
          if (!line.trim()) continue;
          const reply = (value: string): void => {
            if (tornDown) return;
            writeFrame(socket, value);
          };
          const finish = (): void => {
            try { socket.end(); } catch { /* 已断开 */ }
          };
          const operation: Promise<void> = Promise.resolve(options.onLine(line, reply, finish))
            .catch(() => { /* 单请求失败不改通道状态。 */ })
            .finally(() => { inFlight.delete(operation); });
          inFlight.add(operation);
        }
        buffers.set(socket, combined);
      },
      close(socket) {
        connections.delete(socket);
        buffers.delete(socket);
        pendingWrites.delete(socket);
        options.onConnectionClosed?.();
        // 客户端收尾后连接自行关闭时再拆除，保证 complete 的 ack 已经送达。
        if (closing && connections.size === 0) teardown();
      },
      error(socket) {
        connections.delete(socket);
        buffers.delete(socket);
        pendingWrites.delete(socket);
        options.onConnectionClosed?.();
        if (closing && connections.size === 0) teardown();
      },
      drain(socket) { continueWrite(socket); },
    },
  });
  return {
    socketPath,
    close() {
      if (closing) return;
      closing = true;
      buffers.clear();
      // 执行器的 finally 与 complete 的响应写回在同一轮：必须先让在途请求把
      // 响应 flush 出去，再结束连接。否则 sidecar 收不到 ack，MCP 调用会一直
      // 等到客户端超时（实测 300 秒）。
      const finish = (): void => {
        for (const socket of [...connections]) {
          pendingWrites.delete(socket);
          try { socket.end(); } catch { /* 已断开 */ }
        }
        connections.clear();
        teardown();
      };
      // 待写数据必须尽量排空：complete 的 ack 或较大的读取响应可能还在写队列里。
      const waitDrain = async (): Promise<void> => {
        const deadline = Date.now() + 500;
        while ([...connections].some((socket) => hasPendingWrite(socket)) && Date.now() < deadline) await Bun.sleep(5);
      };
      const settle = (): void => { void waitDrain().then(finish); };
      if (inFlight.size === 0) { settle(); return; }
      // complete 的 onCompleted 会在响应写回前触发执行器收尾，所以这里给在途请求
      // 一个很短的窗口把响应写完；卡在 block 等等待中的请求不阻塞收尾。
      const timer = setTimeout(settle, 150);
      timer.unref?.();
      void Promise.allSettled([...inFlight]).then(() => { clearTimeout(timer); settle(); }, () => { clearTimeout(timer); settle(); });
      return;
    },
  };
}

/** sidecar 侧的控制通道客户端；连接断开时拒绝所有等待中的请求。 */
export type ControlSocketClient = {
  /** 发送一条请求并等待同 requestId 的响应；通道关闭时抛出。 */
  request(payload: Record<string, unknown>): Promise<unknown>;
  /** 关闭底层连接；幂等。 */
  close(): void;
  /** 通道被 Engine 关闭时 resolve；sidecar 据此自行退出。 */
  readonly closed: Promise<void>;
};

/** 连接 Engine 的私有控制 socket；启动早期允许短暂重试。 */
export async function connectControlSocket(options: {
  readonly socketPath: string;
  /** 请求 id 前缀，便于日志中区分来源。 */
  readonly idPrefix: string;
}): Promise<ControlSocketClient> {
  let next = 1;
  let closed = false;
  let buffered = Buffer.alloc(0);
  /** 连接句柄在 finish 之后才可用时应清理的写队列由 close 处理；这里记录引用便于收尾。 */
  let socketRef: Socket | null = null;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const finish = (reason: Error): void => {
    if (closed) return;
    closed = true;
    for (const waiting of pending.values()) waiting.reject(reason);
    pending.clear();
    if (socketRef) pendingWrites.delete(socketRef);
    resolveClosed();
  };
  const socket = await connectWithRetry(options.socketPath, (data) => {
    buffered = Buffer.concat([buffered, Buffer.from(data)]);
    let index = buffered.indexOf(0x0a);
    while (index >= 0) {
      const line = buffered.subarray(0, index).toString("utf8");
      buffered = buffered.subarray(index + 1);
      index = buffered.indexOf(0x0a);
      const value = parseResponse(line);
      if (!value) continue;
      const waiting = pending.get(value.requestId);
      if (!waiting) continue;
      pending.delete(value.requestId);
      if (value.ok === true) waiting.resolve(value.result);
      else waiting.reject(new Error(value.error));
    }
  }, (reason) => finish(reason));
  socketRef = socket;
  return {
    closed: closedPromise,
    async request(payload: Record<string, unknown>): Promise<unknown> {
      if (closed) throw new Error("私有控制通道已关闭。");
      const requestId = `${options.idPrefix}-${process.pid}-${next++}`;
      const response = new Promise<unknown>((resolve, reject) => { pending.set(requestId, { resolve, reject }); });
      void response.catch(() => undefined);
      try { writeFrame(socket, JSON.stringify({ requestId, ...payload })); }
      catch (error) { pending.delete(requestId); throw error; }
      return response;
    },
    close() {
      finish(new Error("私有控制通道已关闭。"));
      pendingWrites.delete(socket);
      try { socket.terminate(); } catch { /* 已断开 */ }
    },
  };
}

/** 连接失败在 sidecar 启动早期可重试；Engine 在 spawn 前已 listen。 */
async function connectWithRetry(socketPath: string, onData: (data: Uint8Array) => void, onClosed: (reason: Error) => void): Promise<Socket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await Bun.connect({
        unix: socketPath,
        socket: {
          open() { /* 连接建立后即可发送请求。 */ },
          data(_socket, data) { onData(data); },
          close() { onClosed(new Error("私有控制通道已被 Engine 关闭。")); },
          error(_socket, error) { onClosed(error instanceof Error ? error : new Error("私有控制通道连接错误。")); },
          drain(socket) { continueWrite(socket); },
        },
      });
    } catch (error) { lastError = error; await Bun.sleep(50); }
  }
  throw new Error(`无法连接私有控制通道：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function parseResponse(line: string): { requestId: string; ok: boolean; result?: unknown; error?: string } | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown };
  if (typeof response.requestId !== "string") return null;
  return { requestId: response.requestId, ok: response.ok === true, ...(response.ok === true ? { result: response.result } : { error: typeof response.error === "string" ? response.error : "私有控制请求失败。" }) };
}

/** 默认根目录：仅独立测试直接使用；生产由 Engine 注入自身 scratch。 */
export function defaultControlRoot(): string { return tmpdir(); }
