import { realpath } from "node:fs/promises";
import type { AcpLauncher, AcpTransportFactory } from "../adapters/acp-session";
import { AcpSessionClient } from "../adapters/acp-session";
import { AcpLeadSession, type LeadMcpServer } from "./acp-lead";
import type { LeadMessage } from "./types";
import { prepareDshLinkShim } from "./dsh-link-shim";
import { managedAcpTransport } from "../workspace/managed-acp-transport";
import { WriterProcessGroups } from "../workspace/writer-process-group";
import { waveFlowHome } from "../journal/paths";
import type { MacosWriteBoundary } from "../workspace/macos-write-sandbox";
import { prepareSessionSkills } from "../skills/session";
import type { SkillInjectionCapability } from "../skills/types";

/**
 * 主控只使用用户已验证的本机 CLI 原生配置；四工具 MCP 由 Engine 注入。
 * OS 写边界默认允许写，但拒绝当前项目与 Engine 状态目录，阻止主控直接修改
 * 业务文件或 Journal/Registry；CLI 权限请求统一 allow，文件写仍受外层边界限制。
 */
export async function createLeadSession(options: {
  /** 经 Registry 复核的 CLI launcher。 */ readonly launcher: AcpLauncher;
  /** 已验证项目 cwd；原生读取保持全局可读，不授权写入。 */ readonly cwd: string;
  /** Engine 预建且 canonical 的私有会话目录；控制端点须位于其内。 */ readonly scratch: string;
  /** 主控角色/作者说明，不作为安全边界。 */ readonly prompt: string;
  /** 原 Journal 有界上下文；不认领旧 ACP session。 */ readonly prior: readonly LeadMessage[];
  /** 仅四个 Lead 控制工具的私有 MCP；端点必须由 Engine 创建。 */ readonly mcp: LeadMcpServer;
  /** 验收观察底层真实 stdio 消息，不替换 OS 边界；生产省略。 */ readonly transport?: AcpTransportFactory;
  /**
   * Engine 状态根目录（生产等于 `waveFlowHome()`）；用于保护 Journal/Registry
   * 不被主控改写。测试可注入临时目录，避免误保护真实用户目录。
   */
  readonly engineHome?: string;
  /** 当前 Adapter 的执行期技能注入能力；缺省表示不注入，技能库非空时由注入器 fail closed。 */
  readonly skills?: SkillInjectionCapability | null;
  /** 技能库根目录；缺省 `waveFlowHome()/skills`，测试与隔离运行可注入。 */
  readonly skillsRoot?: string;
}): Promise<AcpLeadSession> {
  const { scratch } = options;
  let actual = options.launcher;
  // DSH 的 JSONL 会话发布依赖 link；macOS 沙箱禁止 file-link，改用 clone/copy 发布。
  if (actual.id === "dsh-acp") actual = await prepareDshLinkShim(actual, scratch);
  // scratch 位于 Engine 状态目录内；profile 内部先 deny 受保护目录再 allow scratch，
  // 因此 MCP 控制 socket 和本会话运行目录仍可写。
  const boundary: MacosWriteBoundary = { scratch, controlFiles: [], protectedDirectories: [await realpath(options.cwd), options.engineHome ?? waveFlowHome()] };
  // 技能投影与注入必须在最终 launcher 确定后、建立 ACP 会话前完成；失败即拒绝启动。
  const prepared = options.skillsRoot === undefined && options.skills === undefined
    ? { launcher: actual, session: undefined, evidence: null }
    : await prepareSessionSkills({ scratch, launcher: actual, capability: options.skills ?? undefined, libraryRoot: options.skillsRoot });
  actual = prepared.launcher;
  const transport = managedAcpTransport({ boundary, groups: new WriterProcessGroups(), bindWriter: async () => {}, transport: options.transport });
  const client = new AcpSessionClient(actual, transport, "allow");
  const session = new AcpLeadSession(actual, options.cwd, options.prompt, options.prior, options.mcp, client, prepared.session);
  const close = session.close.bind(session);
  session.close = () => { close(); void client.verifyClosed().catch(() => { /* 关闭不等待，未核验退出不开放任何业务写权限。 */ }); };
  return session;
}
