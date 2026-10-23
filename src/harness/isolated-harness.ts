import { realpath } from "node:fs/promises";
import type { AcpLauncher, AcpTransportFactory } from "../adapters/acp-session";
import { AcpSessionClient } from "../adapters/acp-session";
import { AcpHarnessSession, type HarnessMcpServer } from "./acp-harness";
import type { HarnessMessage } from "./types";
import { prepareIsolatedLauncher, type SessionIsolationProfile } from "../runtimes/session-isolation";
import { managedAcpTransport } from "../workspace/managed-acp-transport";
import { WriterProcessGroups } from "../workspace/writer-process-group";
import { waveFlowHome } from "../journal/paths";
import type { MacosWriteBoundary } from "../workspace/macos-write-sandbox";
import { prepareSessionSkills } from "../skills/session";
import type { SkillInjectionCapability } from "../skills/types";

/** 生产主控默认只写会话scratch，业务文件由CLI原生读取；四工具MCP由Engine注入。
 * CLI权限请求统一allow，文件写仍受外层OS边界限制；不存在业务写升级入口。
 * 感知模式例外：使用用户原生CLI配置，OS边界改为只拒绝写当前项目与Engine状态目录。
 */
export async function createIsolatedHarness(options: {
  /** 经Registry复核的CLI launcher；不按CLI名称判断隔离能力。 */ readonly launcher: AcpLauncher;
  /** Adapter Catalog提供的私有状态准备能力；仅isolated模式使用，缺省拒绝而非普通启动回退。 */ readonly isolation?: SessionIsolationProfile;
  /** 已验证项目cwd；原生读取保持全局可读，不授权写入。 */ readonly cwd: string;
  /** Engine预建且canonical的私有会话目录；FIFO须位于其内。 */ readonly scratch: string;
  /** 主控角色/作者说明，不作为安全边界。 */ readonly prompt: string;
  /** 原Journal有界上下文；不认领旧ACP session。 */ readonly prior: readonly HarnessMessage[];
  /** 仅四个Harness控制工具的私有MCP；端点必须由Engine创建。 */ readonly mcp: HarnessMcpServer;
  /** 验收观察底层真实stdio消息，不替换OS边界；生产省略。 */ readonly transport?: AcpTransportFactory;
  /**
   * 主控会话模式，缺省 `"isolated"`：
   * - `"isolated"`：准备私有 Home，生成“拒绝全部写、白名单放行”的 OS 边界；
   * - `"perception"`：跳过私有 Home，直接使用用户原生 launcher，只保护当前项目与
   *   Engine 状态目录（`engineHome`），scratch 仍可写。
   * 模式由 Desktop Engine 每次创建会话时按 `AppSettings.perceptionMode` 传入。
   */
  readonly mode?: "isolated" | "perception";
  /**
   * Engine 状态根目录（生产等于 `waveFlowHome()`）；仅 perception 模式用于保护
   * Journal/Registry 不被主控改写。测试可注入与 `settingsRoot` 相同的临时目录，
   * 避免误保护真实用户目录；缺省使用 `waveFlowHome()`。
   */
  readonly engineHome?: string;
  /**
   * 当前 Adapter 的执行期技能注入能力；缺省表示不注入，技能库非空时由注入器 fail closed。
   * 能力来自 Adapter Catalog，不按 CLI 名称在 Harness 内分支。
   */
  readonly skills?: SkillInjectionCapability | null;
  /** 技能库根目录；缺省 `waveFlowHome()/skills`，测试与隔离运行可注入。与 skills 同时缺省表示不启用注入（仅测试/旧调用）。 */
  readonly skillsRoot?: string;
}): Promise<AcpHarnessSession> {
  const { launcher, scratch } = options;
  const mode = options.mode ?? "isolated";
  let actual: AcpLauncher;
  let boundary: MacosWriteBoundary;
  if (mode === "isolated") {
    actual = await prepareIsolatedLauncher(options.isolation, launcher, scratch, "harness");
    boundary = { workspace: null, mode, scratch, controlFiles: [], readOnlyPaths: options.isolation?.readOnlyPaths(actual) ?? [], cliWritableRoots: options.isolation?.writableRoots?.(actual) ?? [], protectedDirectories: [await realpath(options.cwd)] };
  } else if (mode === "perception") {
    // 感知模式保留用户已安装的 skill/MCP/CLI 与登录态：不复制私有 Home、不覆盖 CLI 配置目录。
    actual = launcher;
    // scratch 位于 Engine 状态目录内；profile 内部先 deny 受保护目录再 allow scratch，
    // 因此 MCP FIFO 和本会话运行目录仍可写。
    boundary = { workspace: null, mode, scratch, controlFiles: [], readOnlyPaths: [], cliWritableRoots: [], protectedDirectories: [await realpath(options.cwd), options.engineHome ?? waveFlowHome()] };
  } else throw new Error("未知主控会话模式，拒绝启动。");
  // 技能投影与注入必须在最终 launcher 确定后、建立 ACP 会话前完成；失败即拒绝启动。
  // skillsRoot 由 Engine 提供；仅当两者都缺省时跳过（直接调用者/旧测试未请求注入）。
  const prepared = options.skillsRoot === undefined && options.skills === undefined
    ? { launcher: actual, session: undefined, evidence: null }
    : await prepareSessionSkills({ scratch, launcher: actual, capability: options.skills ?? undefined, libraryRoot: options.skillsRoot });
  actual = prepared.launcher;
  const transport = managedAcpTransport({ boundary, groups: new WriterProcessGroups(), bindWriter: async () => {}, transport: options.transport });
  const client = new AcpSessionClient(actual, transport, "allow");
  const session = new AcpHarnessSession(actual, options.cwd, options.prompt, options.prior, options.mcp, client, prepared.session);
  const close = session.close.bind(session);
  session.close = () => { close(); void client.verifyClosed().catch(() => { /* 关闭不等待，未核验退出不开放任何业务写权限。 */ }); };
  return session;
}
