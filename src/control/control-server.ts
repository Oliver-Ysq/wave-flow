import Ajv from "ajv";
import type { RunJournal } from "../journal/run-journal";
import type { JournalEvent } from "../journal/types";
import type { RunStateMachine } from "../runtime/run-state-machine";
import type { JsonObject } from "../shared/json";
import type { JsonSchema } from "../shared/workflow-types";

/** 注册后仅在当前 daemon 生命周期有效的节点 capability。 */
export type RegisteredControlNode = {
  /** 所属 Run。 */
  readonly runId: string;
  /** 节点稳定 id。 */
  readonly nodeId: string;
  /** 真实 Agent 会话身份；为空时节点尚未接入受管 Control。 */
  readonly agentSessionId: string;
  /** 仅注入受管 Agent 会话环境的高熵 capability。 */
  readonly capability: string;
};

/** 受管 CLI 提交 complete 时发送的 JSON 内容；daemon 不读取调用方任意路径。 */
export type CompleteRequest = RegisteredControlNode & {
  /** 可选展示摘要；仅用于诊断，不替代 JSON 结果。 */
  readonly summary: string;
  /** 受管 CLI 已在本地读取的 JSON 对象结果。 */
  readonly result: JsonObject;
};

/** Control Server 的最小 complete 协议。 */
export class ControlServer {
  #nodes = new Map<string, RegisteredControlNode>();
  #completing = new Set<string>();

  constructor(private readonly journal: RunJournal, private readonly state: RunStateMachine) {}

  /** 注册一个已进入 running 的真实 Agent；同一 node/session 只能注册一次。 */
  register(node: RegisteredControlNode): void {
    if (node.runId !== this.journal.manifest.runId) throw new Error("Control 节点不属于当前 Run。");
    if (!node.agentSessionId.trim() || !node.capability.trim()) throw new Error("Control 注册缺少会话身份或 capability。");
    const snapshot = this.state.agent(node.nodeId);
    if (snapshot.status !== "running" || snapshot.agentSessionId !== node.agentSessionId) throw new Error("Control 只能注册当前 running 的同一 Agent 会话。");
    const key = controlKey(node.runId, node.nodeId);
    if (this.#nodes.has(key)) throw new Error("Control 节点已注册。");
    this.#nodes.set(key, node);
  }

  /** 校验 capability、Schema 与 durable 写入后，唯一地完成 running 节点。 */
  async complete(request: CompleteRequest): Promise<void> {
    const key = controlKey(request.runId, request.nodeId);
    const node = this.#nodes.get(key);
    if (!node || node.agentSessionId !== request.agentSessionId || node.capability !== request.capability) throw new Error("Control capability、Run、节点或会话身份不匹配。");
    if (this.#completing.has(key)) throw new Error("该节点正在处理 complete，拒绝并发上报。");
    this.#completing.add(key);
    try {
    if (!request.summary.trim()) throw new Error("complete summary 必须非空。");
    const snapshot = this.state.agent(request.nodeId);
    if (snapshot.status !== "running") throw new Error(`complete 只允许当前 running 节点，实际为 ${snapshot.status}。`);
    if (snapshot.agentSessionId !== request.agentSessionId) throw new Error("complete 会话身份与当前节点不匹配。");
    validateSchema(snapshot.request.schema, request.result);
    const resultPath = await this.journal.writeResult(request.nodeId, request.result);
    const validationPath = await this.journal.writeValidation(request.nodeId, snapshot.request.schema ?? {}, request.result);
    const event: JournalEvent = { type: "agent.completed", at: new Date().toISOString(), runId: request.runId, nodeId: request.nodeId, agentSessionId: request.agentSessionId, diagnostic: request.summary, resultPath, validationPath, result: request.result };
    await this.journal.append(event);
    this.state.apply(event);
    this.#nodes.delete(key);
    } finally {
      this.#completing.delete(key);
    }
  }
}

function controlKey(runId: string, nodeId: string): string { return `${runId}\0${nodeId}`; }

function validateSchema(schema: JsonSchema | undefined, result: JsonObject): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validator(result)) throw new Error(`complete 结果不符合节点 schema：${new Ajv({ allErrors: true, strict: false }).errorsText(validator.errors)}`);
}
