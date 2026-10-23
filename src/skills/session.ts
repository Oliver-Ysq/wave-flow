import { readSkillLibrary, skillLibraryRoot } from "./library";
import { createSkillProjection } from "./projection";
import type { PreparedSessionSkills, SkillEvidence, SkillInjectionCapability } from "./types";
import type { AcpLauncher } from "../adapters/acp-session";

/** 写入 Journal 的 skill 名单上限；完整数量与摘要仍保留。 */
const MAX_EVIDENCE_NAMES = 200;

/**
 * 在启动 ACP 会话前完成技能库扫描、投影与注入。
 *
 * 语义：空库是无副作用的 no-op；库非空但当前 CLI 没有已验证注入能力时 fail closed，
 * 不静默跳过、不回退到其他 CLI。本函数只读技能库、只写会话 scratch，不启动进程。
 */
export async function prepareSessionSkills(input: {
  /** 已由 prepareSessionScratch 创建并校验的会话私有目录。 */
  readonly scratch: string;
  /** 已由 Adapter Catalog 组装的启动配置；可能被注入追加参数。 */
  readonly launcher: AcpLauncher;
  /** 当前 Adapter 的注入能力；未声明表示该 CLI 不支持。 */
  readonly capability?: SkillInjectionCapability;
  /** 技能库根；缺省 `waveFlowHome()/skills`，测试与隔离运行可注入。 */
  readonly libraryRoot?: string;
}): Promise<PreparedSessionSkills> {
  const library = await readSkillLibrary(input.libraryRoot ?? skillLibraryRoot());
  if (library.skills.length === 0) return { launcher: input.launcher, evidence: null };
  const capability = input.capability;
  if (!capability || !capability.verified) {
    throw new Error(`技能库已有 ${library.skills.length} 个 skill，但当前执行底座（${input.launcher.id}）尚未通过执行期技能注入验证。请改用已验证的 CLI，或暂时清空技能库。 `);
  }
  try {
    const projection = await createSkillProjection(input.scratch, library);
    if (!projection) return { launcher: input.launcher, evidence: null };
    const applied = capability.apply({ launcher: input.launcher, projection });
    const evidence: SkillEvidence = {
      digest: library.digest,
      mechanism: capability.mechanism,
      count: library.skills.length,
      names: library.skills.slice(0, MAX_EVIDENCE_NAMES).map(skill => skill.name),
    };
    return { launcher: applied.launcher, ...(applied.session ? { session: applied.session } : {}), evidence };
  } catch (error) {
    throw new Error(`技能注入失败：${error instanceof Error ? error.message : String(error)} `);
  }
}
