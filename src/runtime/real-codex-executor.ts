import { join } from "node:path";
import { CodexInteractiveAdapter } from "../adapters/codex-interactive-adapter";
import type { ControlServer } from "../control/control-server";
import { nodeDirectoryName } from "../journal/paths";
import type { SessionBackend, SessionIdentity } from "../sessions/types";
import { InteractiveCliBootstrap } from "../sessions/bootstrap/interactive-cli-bootstrap";
import type { InteractiveCliStartRequest } from "../adapters/interactive-cli-adapter";
import type { JsonObject } from "../shared/json";
import type { AgentNodeExecutor, AgentNodeSnapshot } from "./run-types";
import { CodexAppServerAdapter, CodexAppServerAmbiguousSubmissionError, type CodexAppServerBinding, CodexAppServerHost, bunCodexAppServerConnection, createCodexRemoteViewer } from "../adapters/codex-app-server";
import { probeCapabilities } from "../daemon/capability-probe";
import type { CapabilitySnapshot, CapabilityStatus } from "../adapters/capabilities";

/** 默认 Codex 真实执行器：以 App Server ACK 投递首条任务，并创建 tmux remote viewer。 */
export class RealCodexExecutor implements AgentNodeExecutor {
  #control: ControlServer | null = null;

  /** @param controlUrl 当前前台 daemon 的 loopback 根地址，仅注入该 Agent 会话。 */
  constructor(
    private readonly sessions: SessionBackend,
    private readonly controlUrl: string,
    private readonly runsRoot: string,
    private readonly startSession: (sessions: SessionBackend, adapter: CodexInteractiveAdapter, request: InteractiveCliStartRequest) => Promise<{ readonly identity: SessionIdentity }> = defaultStartSession,
    private readonly livenessPollMs = 1_000,
    private readonly codexRpcInput = true,
    private readonly startHybrid: (sessions: SessionBackend, node: AgentNodeSnapshot, prompt: string, identityFile: string, env: Readonly<Record<string, string>>) => Promise<{ readonly identity: SessionIdentity; readonly binding: CodexAppServerBinding; /** App Server 进程退出时 resolve；fake 启动器可省略。 */ readonly exited?: Promise<number>; stop(): void }> = defaultStartHybrid,
  ) {}

  /** Runtime 创建 ControlServer 后绑定；未绑定时拒绝启动，避免无 capability 的真实 Agent。 */
  bindControl(control: ControlServer): void {
    if (this.#control) throw new Error("真实 Codex 执行器已绑定 ControlServer。");
    this.#control = control;
  }

  /** 启动前重新读取本机 tmux 与 Codex 二进制状态；unknown 绝不被当成可用。 */
  probeCapabilities(): Promise<CapabilitySnapshot> { return probeCapabilities(); }

  /** 当前真实路径至少需要可创建私有 tmux 会话与可执行的 Codex；首条投递另由 Gate 验证。 */
  requiredCapabilities(): Readonly<Record<string, (snapshot: CapabilitySnapshot) => CapabilityStatus>> {
    return {
      "tmux.persistentSessions": (snapshot) => snapshot.host.tmux.persistentSessions,
      "codex.binary": (snapshot) => snapshot.adapters.codex.status,
    };
  }

  /** 创建真实 tmux/Codex 会话，确认首条 Prompt 后注册 capability，并等待 complete 回调。 */
  async execute(node: AgentNodeSnapshot): Promise<JsonObject> {
    const control = this.#control;
    if (!control) throw new Error("真实 Codex 执行器尚未绑定 ControlServer。");
    if (!node.agentSessionId) throw new Error("真实 Codex 节点缺少 agentSessionId。");
    const capability = crypto.randomUUID();
    const sessionEnv = {
        WF_CONTROL_URL: this.controlUrl,
        WF_RUN_ID: control.runId,
        WF_NODE_ID: node.id,
        WF_AGENT_SESSION_ID: node.agentSessionId,
        WF_CONTROL_CAPABILITY: capability,
      };
    let settled = false;
    let resolveCompletion!: (result: JsonObject) => void;
    let rejectCompletion!: (error: Error) => void;
    const completionWithFailure = new Promise<JsonObject>((resolve, reject) => {
      resolveCompletion = (result) => { if (!settled) { settled = true; resolve(result); } };
      rejectCompletion = (error) => { if (!settled) { settled = true; reject(error); } };
    });
    // App Server 退出可能在调用方拿到 execute() 返回 Promise 前发生；先登记一个
    // 旁路 rejection handler，避免 Bun 将正确传播给调用方的中断误报为未处理拒绝。
    void completionWithFailure.catch(() => undefined);
    control.register({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, capability, onCompleted: resolveCompletion });
    let stopHybrid: (() => void) | null = null;
    const cleanupHybrid = () => { if (stopHybrid !== null) stopHybrid(); };
    try {
      const identityFile = join(this.runsRoot, control.runId, "nodes", nodeDirectoryName(node.id), "session.json");
      let started: { readonly identity: SessionIdentity };
      let hybridBinding: CodexAppServerBinding | null = null;
      if (this.codexRpcInput) {
        try {
          const hybrid = await this.startHybrid(this.sessions, node, managedPrompt(node), identityFile, sessionEnv);
          started = hybrid;
          stopHybrid = hybrid.stop;
          hybridBinding = hybrid.binding;
          if (hybrid.exited) {
            void hybrid.exited.then((code) => {
              if (settled) return;
              control.unregister(control.runId, node.id, node.agentSessionId!);
              cleanupHybrid();
              rejectCompletion(new Error(`Codex App Server 进程已退出：${code}`));
            }).catch((error) => {
              if (settled) return;
              control.unregister(control.runId, node.id, node.agentSessionId!);
              cleanupHybrid();
              rejectCompletion(new Error(`Codex App Server 退出状态不可验证：${error instanceof Error ? error.message : String(error)}`));
            });
          }
        } catch (error) {
          if (error instanceof CodexAppServerAmbiguousSubmissionError) throw error;
          started = await this.startOrdinary(node, control.runId, identityFile, sessionEnv);
        }
      } else {
        started = await this.startOrdinary(node, control.runId, identityFile, sessionEnv);
      }
      await control.recordSession(hybridBinding
        ? { runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, session: started.identity, delivery: "codex-rpc", appServer: hybridBinding }
        : { runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId, session: started.identity, delivery: "tmux" });
      void this.monitorSession(started.identity, () => settled, (error) => {
        control.unregister(control.runId, node.id, node.agentSessionId!);
        cleanupHybrid();
        rejectCompletion(error);
      });
      return completionWithFailure.finally(cleanupHybrid);
    } catch (error) {
      cleanupHybrid();
      control.unregister(control.runId, node.id, node.agentSessionId);
      throw error;
    }
  }

  private startOrdinary(node: AgentNodeSnapshot, runId: string, identityFile: string, sessionEnv: Readonly<Record<string, string>>): Promise<{ readonly identity: SessionIdentity }> {
    return this.startSession(this.sessions, new CodexInteractiveAdapter(this.sessions, { sessionEnv }), { runId, node, prompt: managedPrompt(node), identityFile });
  }

  private async monitorSession(identity: SessionIdentity, isSettled: () => boolean, reject: (error: Error) => void): Promise<void> {
    while (true) {
      await delay(this.livenessPollMs);
      if (isSettled()) return;
      const live = await this.sessions.liveness(identity);
      if (live === "exists") continue;
      reject(new Error(`真实 Agent 会话无法继续验证：${live}`));
      return;
    }
  }
}

async function defaultStartSession(sessions: SessionBackend, adapter: CodexInteractiveAdapter, request: InteractiveCliStartRequest): Promise<{ readonly identity: SessionIdentity }> {
  return new InteractiveCliBootstrap(sessions).start(adapter, request);
}

function managedPrompt(node: AgentNodeSnapshot): string {
  return `${node.request.prompt}\n\n完成任务后必须执行以下步骤：\n1. 将最终结构化结果写入一个绝对路径的 JSON 文件，文件内容必须是 JSON 对象。\n2. 执行 wave-flow complete --summary <简短完成说明> --result-file <该绝对路径>。\n若遇到无法安全继续的需求、环境或逻辑阻塞，执行 wave-flow block --need-help <完整说明> [--answer-schema <JSON Schema>]；命令会返回 blockRequestId 和 JSON 答案。验证答案已解决阻塞后，再执行 wave-flow continue --block-request-id <该 id>。\n不要仅用自然语言声称完成；只有上述命令成功后节点才会完成。`;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function defaultStartHybrid(sessions: SessionBackend, node: AgentNodeSnapshot, prompt: string, identityFile: string, env: Readonly<Record<string, string>>): Promise<{ readonly identity: SessionIdentity; readonly binding: CodexAppServerBinding; readonly exited: Promise<number>; stop(): void }> {
  const host = new CodexAppServerHost(undefined, "codex", 10_000, env);
  try {
    const endpoint = await host.start(bunCodexAppServerConnection, new AbortController().signal);
    const adapter = new CodexAppServerAdapter(endpoint, bunCodexAppServerConnection);
    const submission = await adapter.submitInitialPrompt(node, prompt, new AbortController().signal);
    let identity: SessionIdentity;
    try {
      identity = await createCodexRemoteViewer(sessions, { runId: env.WF_RUN_ID, node, identityFile }, submission.binding);
    } catch (error) {
      throw new CodexAppServerAmbiguousSubmissionError(`App Server 已确认首条任务但 remote viewer 创建失败，禁止回退投递：${error instanceof Error ? error.message : String(error)}`);
    }
    return { identity, binding: submission.binding, exited: host.exited, stop: () => { void adapter.close(); host.stop(); } };
  } catch (error) {
    host.stop();
    throw error;
  }
}
