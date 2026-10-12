import type { ControlServer } from "../control/control-server";
import { resolveCodexAcpLauncher } from "../runtimes/worker-launcher-resolver";
import { runtimeProvenance } from "../runtimes/worker-launcher-resolver";
import type { CliRuntimeRegistry } from "../runtimes/registry";
import { AcpWorkerExecutor } from "./acp-worker-executor";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";

/**
 * 延迟解析用户 Runtime 的 ACP Executor。Run/Execution 可先建立 Journal 与 Control，
 * 但真正启动第一个 Agent 前必须再次读取 Registry 并复核 CLI 文件身份；无默认
 * runtime 时 fail closed，绝不回退到随包 Codex。
 */
export class RuntimeAcpWorkerExecutor implements AgentNodeExecutor {
  #control: ControlServer | null = null;
  #workers = new Map<string, AcpWorkerExecutor>();

  constructor(private readonly runtimes: CliRuntimeRegistry, private readonly controlCommand: () => string) {}

  bindControl(control: ControlServer): void {
    if (this.#control) throw new Error("Runtime ACP Worker 已绑定 ControlServer。 ");
    this.#control = control;
  }

  async execute(node: AgentNodeSnapshot) {
    const control = this.#control;
    if (!control) throw new Error("Runtime ACP Worker 尚未绑定 ControlServer。 ");
    const runtime = await this.runtimes.resolveSelected("codex");
    const worker = new AcpWorkerExecutor(resolveCodexAcpLauncher(runtime, this.controlCommand()), undefined, runtimeProvenance(runtime));
    worker.bindControl(control);
    const key = keyOf(node);
    this.#workers.set(key, worker);
    try { return await worker.execute(node); }
    finally { this.#workers.delete(key); }
  }
  async pause(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void> { return this.require(node).pause(node, signal); }
  async recover(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<{}> { return this.require(node).recover(node, signal); }
  async stop(node: AgentNodeSnapshot): Promise<void> { return this.require(node).stop(node); }
  private require(node: AgentNodeSnapshot): AcpWorkerExecutor { const worker = this.#workers.get(keyOf(node)); if (!worker) throw new Error(`节点 ${node.id} 没有可控制的本机 CLI ACP 会话。`); return worker; }
}
function keyOf(node: AgentNodeSnapshot): string { return `${node.id}:${node.agentSessionId ?? ""}`; }
