import { bunAcpTransport, type AcpTransportFactory } from "../adapters/acp-session";
import { WorkflowContractError } from "../workflow/errors";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { macosWriteProfile, type MacosWriteBoundary } from "./macos-write-sandbox";
import type { WriterProcessGroups } from "./writer-process-group";

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
    const objects = `${options.boundary.scratch}/objects`;
    await mkdir(objects, { recursive: true, mode: 0o700 });
    const info = await lstat(objects);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(objects) !== objects) throw new WorkflowContractError("受管Git私有对象目录不安全。");
    const env: Record<string, string> = { ...launcher.env, TMPDIR: options.boundary.scratch, GIT_OBJECT_DIRECTORY: objects, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    Object.assign(env, { GIT_AUTHOR_NAME: "Wave Flow", GIT_AUTHOR_EMAIL: "workspace@wave-flow.local", GIT_COMMITTER_NAME: "Wave Flow", GIT_COMMITTER_EMAIL: "workspace@wave-flow.local" });
    if (options.boundary.commonDirectory) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = `${options.boundary.commonDirectory}/objects`;
    const transport = await (options.transport ?? bunAcpTransport)({ ...launcher, command: "/usr/bin/sandbox-exec", args: ["-p", profile, launcher.command, ...launcher.args], env }, signal);
    const writer = transport.writerProcess;
    if (!writer) { transport.close(); throw new WorkflowContractError("受管ACP transport没有真实进程组，拒绝启动写Worker。"); }
    const identity = options.groups.register(writer);
    try { await options.bindWriter(identity); }
    catch (error) { transport.close(); throw error; }
    return { ...transport, verifyClosed: () => options.groups.closeAndVerify(identity) };
  };
}
