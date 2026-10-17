import { realpath } from "node:fs/promises";
import type { AcpLauncher, AcpTransportFactory } from "../adapters/acp-session";
import { AcpSessionClient } from "../adapters/acp-session";
import { AcpHarnessSession, type HarnessMcpServer } from "./acp-harness";
import type { HarnessMessage } from "./types";
import { prepareIsolatedLauncher, type SessionIsolationProfile } from "../runtimes/session-isolation";
import { managedAcpTransport } from "../workspace/managed-acp-transport";
import { WriterProcessGroups } from "../workspace/writer-process-group";

/** 生产主控只写会话scratch，业务文件由CLI原生读取；四工具MCP由Engine注入。
 * CLI权限请求统一allow，文件写仍受外层OS边界限制；不存在业务写升级入口。
 */
export async function createIsolatedHarness(options: {
  /** 经Registry复核的CLI launcher；不按CLI名称判断隔离能力。 */ readonly launcher: AcpLauncher;
  /** Adapter Catalog提供的私有状态准备能力；缺省拒绝而非普通启动回退。 */ readonly isolation?: SessionIsolationProfile;
  /** 已验证项目cwd；原生读取保持全局可读，不授权写入。 */ readonly cwd: string;
  /** Engine预建且canonical的私有会话目录；FIFO须位于其内。 */ readonly scratch: string;
  /** 主控角色/作者说明，不作为安全边界。 */ readonly prompt: string;
  /** 原Journal有界上下文；不认领旧ACP session。 */ readonly prior: readonly HarnessMessage[];
  /** 仅四个Harness控制工具的私有MCP；端点必须由Engine创建。 */ readonly mcp: HarnessMcpServer;
  /** 验收观察底层真实stdio消息，不替换OS边界；生产省略。 */ readonly transport?: AcpTransportFactory;
}): Promise<AcpHarnessSession> {
  const { launcher, scratch } = options;
  const actual = await prepareIsolatedLauncher(options.isolation, launcher, scratch, "harness");
  const transport = managedAcpTransport({ boundary: { workspace: null, scratch, controlFiles: [], readOnlyPaths: options.isolation?.readOnlyPaths(actual) ?? [], cliWritableRoots: options.isolation?.writableRoots?.(actual) ?? [], protectedDirectories: [await realpath(options.cwd)] }, groups: new WriterProcessGroups(), bindWriter: async () => {}, transport: options.transport });
  const client = new AcpSessionClient(actual, transport, "allow");
  const session = new AcpHarnessSession(actual, options.cwd, options.prompt, options.prior, options.mcp, client);
  const close = session.close.bind(session);
  session.close = () => { close(); void client.verifyClosed().catch(() => { /* 关闭不等待，未核验退出不开放任何业务写权限。 */ }); };
  return session;
}
