import { createHash } from "node:crypto";
import type { PreviewAgent } from "../workflow/restricted/extract-agents";

/** 展示解析规则版本；规则变化时递增，旧预览只补算一次，不改变草案身份。 */
export const REVISION_PREVIEW_VERSION = 2;

/** 随 revision 耐久的源码展示投影；不包含 Runtime 池，不构成执行授权或可运行证明。 */
export type RevisionPreview = {
  /** 生成此预览的规则版本；正整数，当前为 REVISION_PREVIEW_VERSION。 */
  readonly previewVersion: number;
  /** 被解析源码的 SHA-256；必须匹配 revision.sourceHash。 */
  readonly sourceHash: string;
  /** 已校验 meta 的有序阶段词表；不表达执行依赖。 */
  readonly phaseTitles: readonly string[];
  /** 每个源码 agent() 调用的展示示意；包含 loop 提示，不是运行节点名单。 */
  readonly previewAgents: readonly PreviewAgent[];
};

/** 只验证持久化形状与 hash 绑定，不重新扫描 AST；未知更高版本由读取方升级处理。 */
export function isRevisionPreview(value: unknown): value is RevisionPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!Number.isInteger(item.previewVersion) || (item.previewVersion as number) < 1 || !/^[a-f0-9]{64}$/.test(String(item.sourceHash))) return false;
  if (!Array.isArray(item.phaseTitles) || !item.phaseTitles.length || item.phaseTitles.length > 200_000 || item.phaseTitles.some(title => typeof title !== "string" || !title.trim()) || new Set(item.phaseTitles).size !== item.phaseTitles.length) return false;
  if (!Array.isArray(item.previewAgents) || item.previewAgents.length > 200_000) return false;
  const keys = new Set<string>();
  return item.previewAgents.every((agent: unknown) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
    const entry = agent as Record<string, unknown>;
    if(entry.nodeId!==undefined&&entry.nodeId!==null&&(typeof entry.nodeId!=="string"||!entry.nodeId.trim()))return false;
    if (typeof entry.key !== "string" || !entry.key || keys.has(entry.key) || typeof entry.name !== "string" || !entry.name.trim() || ![null, "codex", "kimi"].includes(entry.cli as never) || typeof entry.loop !== "boolean" || (entry.phaseTitle !== null && typeof entry.phaseTitle !== "string")) return false;
    keys.add(entry.key);
    return true;
  });
}

/** 检查预览与源码绑定；不编译、不执行，旧预览不得变更 revision 的 source/hash。 */
export function previewMatchesSource(preview: RevisionPreview, source: string, sourceHash: string): boolean {
  return preview.sourceHash === sourceHash && createHash("sha256").update(source).digest("hex") === sourceHash;
}
