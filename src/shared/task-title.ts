/** 手动标题去除首尾空白，允许1–120个Unicode字符；非法输入抛错，不截断。 */
export function normalizeTaskTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value) || Array.from(value.trim()).length > 120) throw new Error("对话名称必须为 1–120 个单行字符。");
  return value.trim();
}
