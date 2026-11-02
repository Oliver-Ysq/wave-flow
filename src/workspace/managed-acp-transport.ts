import { existsSync } from "node:fs";
import { bunAcpTransport, supervisedAcpTransport, type AcpTransportFactory } from "../adapters/acp-session";
import { WorkflowContractError } from "../workflow/errors";
import { macosWriteProfile, type MacosWriteBoundary } from "./macos-write-sandbox";
import { WriterProcessGroups } from "./writer-process-group";

/** macOS 写边界依赖的系统沙箱执行器；宿主不随包分发，缺失时必须给出可操作诊断。 */
const SYSTEM_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** 受管写边界是否可用；供规划/预检在不启动 Worker 的前提下给出原因。 */
export function managedWriteBoundaryAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SYSTEM_SANDBOX_EXEC);
}

/**
 * 只读/非受管 Worker 的退出核验包装：不施加 macOS 写边界，但保留真实进程组
 * 登记与 close 后的独立退出核验，避免 finalize 在没有证明时假装完成。
 */
export function verifiedAcpTransport(options?: {
  /** 自动测试替换底层 stdio，不替换进程组核验。 */
  readonly transport?: AcpTransportFactory;
}): AcpTransportFactory {
  const base = options?.transport ?? supervisedAcpTransport;
  return async (launcher, signal) => {
    const transport = await base(launcher, signal);
    const writer = transport.writerProcess;
    if (!writer) {
      transport.close();
      throw new WorkflowContractError("ACP transport没有真实进程组，拒绝启动不可核验的Worker。");
    }
    const groups = new WriterProcessGroups();
    const identity = groups.register(writer);
    return { ...transport, verifyClosed: () => groups.closeAndVerify(identity) };
  };
}

/**
 * 为已验证 ACP launcher 施加后代继承的 OS 写边界，并登记真实进程组。
 *
 * 写者证据（pgid/启动指纹/spawn 意图）由 Run Journal 记录；这里只保留本 Engine
 * 内存中的进程组登记，用于 close 后的退出核验。返回的 close 不等待，交接单独
 * await verifyClosed；失败保留现场。
 */
export function managedAcpTransport(options: {
  /** Engine 指定的受管 cwd/scratch/控制端点边界，不由 Workflow 或模型提供。 */
  readonly boundary: MacosWriteBoundary;
  /** 自动测试替换底层 stdio，不替换 OS profile 路径校验。 */
  readonly transport?: AcpTransportFactory;
}): AcpTransportFactory {
  return async (launcher, signal) => {
    if (!managedWriteBoundaryAvailable()) {
      throw new WorkflowContractError(`受管写隔离依赖系统 ${SYSTEM_SANDBOX_EXEC}（macOS 自带），但本机不可用；请改用只读 Workflow 或修复系统后重试。 `);
    }
    const profile = await macosWriteProfile(options.boundary);
    // 主控使用用户原生 CLI 环境；保留用户 git 配置，因为它可能依赖自己的 skill/CLI 读取资料。
    const env: Record<string, string> = { ...launcher.env, TMPDIR: options.boundary.scratch };
    const transport = await (options.transport ?? bunAcpTransport)({ ...launcher, command: SYSTEM_SANDBOX_EXEC, args: ["-p", profile, launcher.command, ...launcher.args], env }, signal);
    const writer = transport.writerProcess;
    if (!writer) { transport.close(); throw new WorkflowContractError("受管ACP transport没有真实进程组，拒绝启动写Worker。"); }
    const groups = new WriterProcessGroups();
    const identity = groups.register(writer);
    return { ...transport, verifyClosed: () => groups.closeAndVerify(identity) };
  };
}
