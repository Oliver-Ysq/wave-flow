import { bunAcpTransport, type AcpTransportFactory } from "../adapters/acp-session";
import { WorkflowContractError } from "../workflow/errors";
import { macosWriteProfile, type MacosWriteBoundary } from "./macos-write-sandbox";
import type { WriterProcessGroups } from "./writer-process-group";

/** 可信Worker的原生stdio传输；不改变HOME/CLI配置，不施加OS文件隔离。
 * 仍在initialize前登记真实进程组，close不等于退出证明。
 */
export function ownedAcpTransport(options: {
  /** 当前Engine真实进程组，不能认领旧PID。 */ readonly groups: WriterProcessGroups;
  /** 业务投递前耐久绑定writer身份；只读Worker无需Git租约。 */ readonly bindWriter: (identity: string) => Promise<void>;
  /** 独立测试底层stdio的注入点。 */ readonly transport?: AcpTransportFactory;
}): AcpTransportFactory {
  return async (launcher, signal) => {
    const transport = await (options.transport ?? bunAcpTransport)(launcher, signal);
    if (!transport.writerProcess) { transport.close(); throw new WorkflowContractError("ACP transport没有真实进程组，拒绝启动Worker。"); }
    const identity = options.groups.register(transport.writerProcess);
    try { await options.bindWriter(identity); } catch (error) { transport.close(); throw error; }
    return { ...transport, verifyClosed: () => options.groups.closeAndVerify(identity) };
  };
}

/** 为已验证ACP launcher施加后代继承的OS写边界，并在任何initialize/prompt前登记writer。
 * 返回的close不等待，Git交接单独await verifyClosed；失败保留宿主租约。
 */
export function managedAcpTransport(options: {
  /** Engine指定的受管cwd/scratch/FIFO边界，不由Workflow或模型提供。 */ readonly boundary: MacosWriteBoundary;
  /** 本Engine进程组登记簿，不能读取旧PID认领会话。 */ readonly groups: WriterProcessGroups;
  /** 创建进程后先耐久绑定随机证明身份，失败立即关闭进程且禁止ACP业务投递。 */ readonly bindWriter: (identity: string) => Promise<void>;
  /** 自动测试替换底层stdio，不替换OS profile路径校验。 */ readonly transport?: AcpTransportFactory;
}): AcpTransportFactory {
  return async (launcher, signal) => {
    const profile = await macosWriteProfile(options.boundary);
    const env: Record<string, string> = { ...launcher.env, TMPDIR: options.boundary.scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const transport = await (options.transport ?? bunAcpTransport)({ ...launcher, command: "/usr/bin/sandbox-exec", args: ["-p", profile, launcher.command, ...launcher.args], env }, signal);
    const writer = transport.writerProcess;
    if (!writer) { transport.close(); throw new WorkflowContractError("受管ACP transport没有真实进程组，拒绝启动写Worker。"); }
    const identity = options.groups.register(writer);
    try { await options.bindWriter(identity); }
    catch (error) { transport.close(); throw error; }
    return { ...transport, verifyClosed: () => options.groups.closeAndVerify(identity) };
  };
}
