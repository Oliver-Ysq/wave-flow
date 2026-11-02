/**
 * 真实模型验收的显式硬截止。
 *
 * Bun 的 per-test timeout 在部分长时间等待形态下不能及时打断（实测有 8 分钟预算的
 * 用例挂到 18 分钟），失败必须可诊断、可复现，不能把整套验收无限拖住。
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超过 ${timeoutMs}ms 未完成`)), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
