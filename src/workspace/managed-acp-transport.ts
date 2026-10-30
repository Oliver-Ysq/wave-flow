import { existsSync } from "node:fs";
import { bunAcpTransport, type AcpTransportFactory } from "../adapters/acp-session";
import { WorkflowContractError } from "../workflow/errors";
import { macosWriteProfile, type MacosWriteBoundary } from "./macos-write-sandbox";
import type { WriterBindingEvidence } from "./workspace-manager";
import { captureWriterStartedAt } from "./writer-process-control";
import type { WriterProcessGroups } from "./writer-process-group";

/** macOS 写边界依赖的系统沙箱执行器；宿主不随包分发，缺失时必须给出可操作诊断。 */
const SYSTEM_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** 受管写边界是否可用；供规划/预检在不启动 Worker 的前提下给出原因。 */
export function managedWriteBoundaryAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SYSTEM_SANDBOX_EXEC);
}

/** 可信Worker的原生stdio传输；不改变HOME/CLI配置，不施加OS文件隔离。
 * 仍在initialize前登记真实进程组，close不等于退出证明。
 */
export function ownedAcpTransport(options: {
  /** 当前Engine真实进程组，不能认领旧PID。 */ readonly groups: WriterProcessGroups;
  /** 业务投递前耐久绑定writer身份；只读Worker无需Git租约。 */
  readonly bindWriter: (identity: string, evidence: WriterBindingEvidence) => Promise<void>;
  /** 独立测试底层stdio的注入点。 */
  readonly transport?: AcpTransportFactory;
  /** 启动时间指纹读取；缺省读真实进程，自动测试注入固定值。 */
  readonly readWriterStartedAt?: (pid: number) => Promise<string>;
  /** 真正 spawn 前耐久启动意图；崩溃后无法用空 writer 身份推断进程未启动。 */
  readonly beginWriterStart?: () => Promise<void>;
  /** 仅底层 spawn 确定失败、进程未创建时撤回启动意图。 */
  readonly cancelWriterStart?: () => Promise<void>;
}): AcpTransportFactory {
  return async (launcher, signal) => {
    await options.beginWriterStart?.();
    const transport = await (async () => {
      try { return await (options.transport ?? bunAcpTransport)(launcher, signal); }
      catch (error) { await options.cancelWriterStart?.(); throw error; }
    })();
    if (!transport.writerProcess) { transport.close(); throw new WorkflowContractError("ACP transport没有真实进程组，拒绝启动Worker。"); }
    const identity = options.groups.register(transport.writerProcess);
    const readStartedAt = options.readWriterStartedAt ?? captureWriterStartedAt;
    // 启动时间指纹必须与身份一起耐久；读不到就拒绝启动，不留下不可核验的租约。
    try { await options.bindWriter(identity, { pgid: transport.writerProcess.pid, startedAt: await readStartedAt(transport.writerProcess.pid) }); } catch (error) { transport.close(); throw error; }
    return { ...transport, verifyClosed: () => options.groups.closeAndVerify(identity) };
  };
}

/** 为已验证ACP launcher施加后代继承的OS写边界，并在任何initialize/prompt前登记writer。
 * 返回的close不等待，Git交接单独await verifyClosed；失败保留宿主租约。
 */
export function managedAcpTransport(options: {
  /** Engine指定的受管cwd/scratch/控制端点边界，不由Workflow或模型提供。 */ readonly boundary: MacosWriteBoundary;
  /** 本Engine进程组登记簿，不能读取旧PID认领会话。 */ readonly groups: WriterProcessGroups;
  /** 创建进程后先耐久绑定随机证明身份，失败立即关闭进程且禁止ACP业务投递。 */ readonly bindWriter: (identity: string) => Promise<void>;
  /** 自动测试替换底层stdio，不替换OS profile路径校验。 */ readonly transport?: AcpTransportFactory;
}): AcpTransportFactory {
  return async (launcher, signal) => {
    if (!managedWriteBoundaryAvailable()) {
      throw new WorkflowContractError(`受管写隔离依赖系统 ${SYSTEM_SANDBOX_EXEC}（macOS 自带），但本机不可用；请改用只读 Workflow 或修复系统后重试。 `);
    }
    const profile = await macosWriteProfile(options.boundary);
    // isolated 模式禁止读取用户 git 配置，避免黑盒 CLI 借全局配置扩大行为；感知模式
    // 刻意保留用户原生 git 环境，因为主控可能用用户自己的 skill/CLI 读取资料。
    const env: Record<string, string> = { ...launcher.env, TMPDIR: options.boundary.scratch, ...(options.boundary.mode === "perception" ? {} : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }) };
    const transport = await (options.transport ?? bunAcpTransport)({ ...launcher, command: SYSTEM_SANDBOX_EXEC, args: ["-p", profile, launcher.command, ...launcher.args], env }, signal);
    const writer = transport.writerProcess;
    if (!writer) { transport.close(); throw new WorkflowContractError("受管ACP transport没有真实进程组，拒绝启动写Worker。"); }
    const identity = options.groups.register(writer);
    try { await options.bindWriter(identity); }
    catch (error) { transport.close(); throw error; }
    return { ...transport, verifyClosed: () => options.groups.closeAndVerify(identity) };
  };
}
