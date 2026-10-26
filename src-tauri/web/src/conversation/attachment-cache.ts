/**
 * 会话内附件 data URL 缓存：按条目数与总字符数双有界的 LRU。
 * 附件耐久不可变，按消息身份缓存安全；只防内存膨胀，不做持久化。
 * 字符数是字节量的安全上界代理（data URL 以 ASCII 为主，base64 部分 1 字符 ≤ 1 字节有效载荷的 4/3 倍）。
 */

/** 默认条目上限：与历史上 128 条限制一致。 */
export const ATTACHMENT_CACHE_MAX_ENTRIES = 128;
/** 默认总字符上限：约 64MB 字符串，避免少量大图把缓存撑到 GB 级。 */
export const ATTACHMENT_CACHE_MAX_CHARS = 64 * 1024 * 1024;

export class AttachmentDataCache {
  /** 键到 data URL；Map 迭代顺序即 LRU 顺序（最旧在前）。 */
  readonly #entries = new Map<string, string>();
  /** 当前缓存的全部 value 字符总数。 */
  #totalChars = 0;

  constructor(
    /** 条目数上限；默认 ATTACHMENT_CACHE_MAX_ENTRIES。 */ readonly maxEntries: number = ATTACHMENT_CACHE_MAX_ENTRIES,
    /** 总字符数上限；默认 ATTACHMENT_CACHE_MAX_CHARS。 */ readonly maxChars: number = ATTACHMENT_CACHE_MAX_CHARS,
  ) {}

  /** 当前缓存条目数。 */
  get size(): number { return this.#entries.size; }
  /** 当前缓存总字符数。 */
  get totalChars(): number { return this.#totalChars; }

  /** 读取并刷新 LRU 位置；未命中返回 undefined。 */
  get(key: string): string | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /** 写入并按条目数与总字符数逐出最旧条目；单条超限时不缓存该条。 */
  set(key: string, value: string): void {
    const prior = this.#entries.get(key);
    if (prior !== undefined) { this.#totalChars -= prior.length; this.#entries.delete(key); }
    if (value.length > this.maxChars) return;
    this.#entries.set(key, value);
    this.#totalChars += value.length;
    while ((this.#entries.size > this.maxEntries || this.#totalChars > this.maxChars) && this.#entries.size > 0) {
      const oldestKey = this.#entries.keys().next().value!;
      const oldest = this.#entries.get(oldestKey)!;
      this.#entries.delete(oldestKey);
      this.#totalChars -= oldest.length;
    }
  }

  /** 清空缓存。 */
  clear(): void { this.#entries.clear(); this.#totalChars = 0; }
}
