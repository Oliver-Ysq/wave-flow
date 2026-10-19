import { useState } from "react";

const prefix = "wave-flow:project-expanded:v1:";
/** 本机展开偏好；默认展开，存储不可用时仍允许正常折叠，不改变Task状态。 */
export function useProjectExpanded(identity: string) {
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(prefix + identity) !== "false"; }
    catch { return true; }
  });
  return [expanded, (next: boolean) => {
    setExpanded(next);
    try { localStorage.setItem(prefix + identity, String(next)); } catch { /* 展示偏好不阻塞导航。 */ }
  }] as const;
}

/** 拖入仅接纳一个绝对路径；文件/目录身份由Engine只读核验，不靠扩展名猜测。 */
export function droppedProjectPath(paths: readonly string[]): string {
  if (paths.length !== 1) throw new Error("请一次拖入一个文件夹。");
  const path = paths[0];
  if (!path || !(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) throw new Error("请使用项目文件夹的绝对路径。");
  return path;
}
