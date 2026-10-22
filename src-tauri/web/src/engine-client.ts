/**
 * Web 侧 Engine 协议客户端。
 *
 * Tauri 只负责把整行 JSONL 写入 Engine stdin，并把响应行/退出事件原样转发；
 * requestId 生成、响应配对、超时与 generation 过滤全部在这里完成。传输端口可注入，
 * 便于不启动真实 Tauri/Engine 也能单测这些边界。
 */

/** 响应行事件：一行完整 JSONL 文本。 */
export type EngineLine = string;

/** 协议传输端口；生产实现走 Tauri，自动测试注入假实现。 */
export type EngineTransport = {
  /** 写入一行 JSONL，返回本次写入所属的 Engine generation。 */
  write(line: string): Promise<number>;
  /** 订阅响应行；返回取消订阅函数，订阅失败必须抛错。 */
  subscribeLine(handler: (line: EngineLine) => void): Promise<() => void>;
  /** 订阅 Engine 退出事件；返回取消订阅函数。 */
  subscribeExit(handler: (generation: number) => void): Promise<() => void>;
};

/** 超时边界（毫秒）；可注入以便测试快速触发超时。 */
export type EngineClientTimeouts = {
  /** 未指定 timeout 参数时使用。 */
  readonly defaultMs: number;
  /** 调用方指定的最小超时。 */
  readonly minMs: number;
  /** 调用方指定的最大超时。 */
  readonly maxMs: number;
};

/** 生产默认：60 秒，允许 1 秒–600 秒。 */
export const DEFAULT_ENGINE_TIMEOUTS: EngineClientTimeouts = {
  defaultMs: 60_000,
  minMs: 1_000,
  maxMs: 600_000,
};

/** 在途请求；generation 在写入成功后回填，用于过滤已退出 Engine 的请求。 */
type PendingAction = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  generation: number;
};

/** 对外接口：只暴露 action 与诊断用的在途计数。 */
export type EngineClient = {
  action<T>(
    name: string,
    args?: Record<string, unknown>,
    timeoutSecs?: number,
  ): Promise<T>;
  /** 当前在途请求数；用于诊断与测试。 */
  pendingCount(): number;
};

/** 创建协议客户端；同一客户端复用一个事件订阅。 */
export function createEngineClient(
  transport: EngineTransport,
  timeouts: EngineClientTimeouts = DEFAULT_ENGINE_TIMEOUTS,
): EngineClient {
  const pending = new Map<string, PendingAction>();
  let listeners: Promise<void> | null = null;
  /** 已观察到退出的最高 generation；晚于写入回填的退出也需要生效。 */
  let exitedThrough = 0;

  /** 按 requestId 唤醒请求；未知/重复/迟到响应直接丢弃。 */
  function settle(line: EngineLine): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    const record = frame as {
      requestId?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (typeof record.requestId !== "string") return;
    const entry = pending.get(record.requestId);
    if (!entry) return;
    pending.delete(record.requestId);
    clearTimeout(entry.timer);
    if (record.ok === true) entry.resolve(record.result ?? null);
    else
      entry.reject(
        new Error(
          typeof record.error === "string"
            ? record.error
            : "Desktop Engine 拒绝请求。",
        ),
      );
  }

  /** 只拒绝满足条件的在途请求；其余（新 generation 的请求）继续等待。 */
  function rejectWhere(
    predicate: (entry: PendingAction) => boolean,
    error: Error,
  ): void {
    for (const [requestId, entry] of pending) {
      if (!predicate(entry)) continue;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** 只注册一次订阅；注册失败时回滚已注册部分，下次 action 可重试。 */
  async function ensureListeners(): Promise<void> {
    if (listeners) return listeners;
    listeners = (async () => {
      const unsubscribers: Array<() => void> = [];
      try {
        unsubscribers.push(await transport.subscribeLine(settle));
        unsubscribers.push(
          await transport.subscribeExit((generation) => {
            exitedThrough = Math.max(exitedThrough, generation);
            // 只拒绝发给已退出 Engine 的请求；写入回填前 generation 为 -1 的请求
            // 留给写入完成后用 exitedThrough 补判，避免"新 Engine 请求被误拒"。
            rejectWhere(
              (entry) => entry.generation !== -1 && entry.generation <= generation,
              new Error("Desktop Engine 已退出。 "),
            );
          }),
        );
      } catch (error) {
        for (const off of unsubscribers.splice(0)) {
          try {
            off();
          } catch {
            /* 退订失败不阻止下次重试 */
          }
        }
        listeners = null;
        throw error;
      }
    })();
    return listeners;
  }

  /** 把秒级参数收敛到配置边界；未传时用默认值。 */
  function resolveTimeoutMs(timeoutSecs?: number): number {
    const raw =
      timeoutSecs === undefined ? timeouts.defaultMs : timeoutSecs * 1_000;
    return Math.min(timeouts.maxMs, Math.max(timeouts.minMs, Math.round(raw)));
  }

  async function action<T>(
    name: string,
    args: Record<string, unknown> = {},
    timeoutSecs?: number,
  ): Promise<T> {
    await ensureListeners();
    const requestId = crypto.randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(requestId)) return;
        reject(new Error("Desktop Engine 请求超时。 "));
      }, resolveTimeoutMs(timeoutSecs));
      pending.set(requestId, { resolve, reject, timer, generation: -1 });
    });
    const line = JSON.stringify({
      requestId,
      method: "engine.action",
      action: name,
      args,
    });
    let generation: number;
    try {
      generation = await transport.write(line);
    } catch (error) {
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        clearTimeout(entry.timer);
      }
      throw error;
    }
    const entry = pending.get(requestId);
    if (entry) {
      if (generation <= exitedThrough) {
        // 写入期间该 Engine 已退出：立即拒绝，不等超时。
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(new Error("Desktop Engine 已退出。 "));
      } else {
        entry.generation = generation;
      }
    }
    return (await response) as T;
  }

  return { action, pendingCount: () => pending.size };
}
