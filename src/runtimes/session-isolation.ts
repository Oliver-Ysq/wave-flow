import type { AcpLauncher } from "../adapters/acp-session";
import { join } from "node:path";
import { homedir } from "node:os";
import { prepareCodexSessionHome, prepareKimiSessionHome } from "../workspace/cli-session-home";
import { WorkflowContractError } from "../workflow/errors";

/** 宿主角色决定OS边界；Adapter只负责运行目录与原生启动配置，不决定业务权限。 */
export type IsolatedSessionRole = "harness";

/** 内置Adapter的实际隔离启动能力；缺省不存在，未知Adapter不能自动使用普通launcher回退。 */
export type SessionIsolationProfile = {
  /** 仅主控harness启用隔离；Worker使用原生launcher，不消费此Profile。 */
  readonly enabledRoles: readonly IsolatedSessionRole[];
  /** 准备私有状态/认证引用并返回固定启动配置；不得启动进程或扩大宿主文件权限。 */
  readonly prepare: (launcher: AcpLauncher, scratch: string, role: IsolatedSessionRole) => Promise<AcpLauncher>;
  /** 私有Home中不可由模型修改的配置、登录引用或目录；由外层OS策略强制。 */
  readonly readOnlyPaths: (launcher: AcpLauncher) => readonly string[];
  /** 当前CLI原生持久目录；默认空，OS层只开放此Adapter声明的目录，不开放其他CLI或整个Home。 */
  readonly writableRoots?: (launcher: AcpLauncher) => readonly string[];
};

/** 通用入口仅按已声明能力派发；新增CLI实现profile后无需改主控/Workspace核心。 */
export async function prepareIsolatedLauncher(profile: SessionIsolationProfile | undefined, launcher: AcpLauncher, scratch: string, role: IsolatedSessionRole): Promise<AcpLauncher> {
  if (!profile?.enabledRoles.includes(role)) throw new WorkflowContractError(`Adapter ${launcher.id} 尚未通过 ${role} 隔离启动验证；拒绝普通启动回退。`);
  return profile.prepare(launcher, scratch, role);
}

/** Codex主控私有状态配置；Worker不使用此私有Home。 */
export const codexSessionIsolation: SessionIsolationProfile = {
  enabledRoles: ["harness"],
  prepare: async (launcher, scratch) => ({ ...launcher, env: { ...launcher.env, CODEX_HOME: await prepareCodexSessionHome(scratch) } }),
  writableRoots: () => [join(homedir(), ".codex")],
  readOnlyPaths: launcher => launcher.env?.CODEX_HOME ? ["config.toml", "plugins", "hooks", "skills", "AGENTS.md"].map(path=>join(launcher.env!.CODEX_HOME,path)) : [],
};

/** Kimi私有状态启动；角色能力由真实隔离链验证，不在主控/Workspace核心按CLI分支。 */
export const kimiSessionIsolation: SessionIsolationProfile = {
  enabledRoles: ["harness"],
  prepare: async (launcher, scratch) => {
    const home = await prepareKimiSessionHome(scratch);
    return { ...launcher, args: ["--skills-dir", join(home, "empty-skills"), ...launcher.args], env: { ...launcher.env, KIMI_CODE_HOME: home, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_DISABLE_TELEMETRY: "1" } };
  },
  writableRoots: () => [join(homedir(), ".kimi-code")],
  readOnlyPaths: launcher => launcher.env?.KIMI_CODE_HOME ? ["config.toml", "mcp.json", "plugins", "hooks", "skills", "AGENTS.md", "empty-skills"].map(path=>join(launcher.env!.KIMI_CODE_HOME,path)) : [],
};
