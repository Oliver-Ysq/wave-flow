/**
 * 左侧任务/对话记录栏宽度的拖动调整与窗口层级耐久保存。
 * 与对话内容列宽度（chat-width）相互独立：侧栏是应用外壳的导航列，
 * 不是居中内容列，宽度随指针一对一变化，不做两倍换算。
 */

/** 侧栏最小宽度；低于它任务标题与操作不可读。 */
export const RAIL_WIDTH_MIN = 200;
/** 侧栏最大宽度；超过它会过度挤压对话区。 */
export const RAIL_WIDTH_MAX = 420;
/** 未保存或保存值无效时的默认宽度，与历史布局一致。 */
export const RAIL_WIDTH_DEFAULT = 260;

const STORAGE_KEY = "wave-flow.rail-width.v1";

/** 把任意输入收敛到合法宽度；非有限数回退默认值。 */
export function clampRailWidth(value: number): number {
  if (!Number.isFinite(value)) return RAIL_WIDTH_DEFAULT;
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(value)));
}

/** 拖动位移 → 新宽度；侧栏贴左，右边框随指针一对一移动。 */
export function railWidthFromDrag(startWidth: number, startClientX: number, currentClientX: number): number {
  return clampRailWidth(startWidth + (currentClientX - startClientX));
}

/** 读取窗口层级保存宽度；缺失、损坏或越界一律回退默认值。 */
export function loadRailWidth(storage: Pick<Storage, "getItem">): number {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return RAIL_WIDTH_DEFAULT;
    return clampRailWidth(Number.parseFloat(raw));
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

/** 耐久保存最终宽度；存储不可用时静默降级为仅本次会话生效。 */
export function persistRailWidth(width: number, storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(STORAGE_KEY, String(clampRailWidth(width)));
  } catch { /* 隐私模式等只读存储不阻断拖动。 */ }
}
