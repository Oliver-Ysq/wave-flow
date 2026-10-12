import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest } from "../shared/workflow-types";
import type { DecisionGateRequest, ExecutionBatch, PhaseVisit, WorkflowExecutionHost } from "./workflow-host";
import { WorkflowContractError } from "../workflow/errors";

/**
 * 受限 Workflow 脚本的资源护栏；只约束 Harness 生成脚本的执行，不影响受信任作者入口。
 * 每个 Execution 创建时冻结快照并随 `workflow.execution_created` 耐久，运行中不得扩大。
 */
export type WorkflowPolicy = {
  /** 单次执行内 agent() 调用的最大总数；超限说明脚本失控或循环暴走。 */
  readonly maxNodes: number;
  /** 单次执行内 phase() 切换的最大次数；用于限制无界阶段回溯循环。 */
  readonly maxPhaseVisits: number;
  /** 单次执行内 decisionGate 声明的最大数量。 */
  readonly maxGates: number;
};

/** Harness 生成脚本的默认护栏；取值是实现验证的初始上限，不是性能结论。 */
export const DEFAULT_RESTRICTED_WORKFLOW_POLICY: WorkflowPolicy = { maxNodes: 20, maxPhaseVisits: 50, maxGates: 10 };

/** 包装任意 WorkflowExecutionHost，在委派前按 Policy 计数拒绝；不持有 Runtime 内部对象。 */
export class PolicyEnforcingHost implements WorkflowExecutionHost {
  #nodes = 0;
  #phaseVisits = 0;
  #gates = 0;

  constructor(
    private readonly inner: WorkflowExecutionHost,
    readonly policy: WorkflowPolicy = DEFAULT_RESTRICTED_WORKFLOW_POLICY,
  ) {}

  agent(request: NormalizedAgentRequest, batch: ExecutionBatch, phaseVisit: PhaseVisit): Promise<JsonObject | null> {
    this.#nodes += 1;
    if (this.#nodes > this.policy.maxNodes) throw new WorkflowContractError(`脚本 agent() 调用超过 Policy 上限 ${this.policy.maxNodes}。`);
    return this.inner.agent(request, batch, phaseVisit);
  }

  phase(title: string): PhaseVisit {
    this.#phaseVisits += 1;
    if (this.#phaseVisits > this.policy.maxPhaseVisits) throw new WorkflowContractError(`脚本 phase() 切换超过 Policy 上限 ${this.policy.maxPhaseVisits}。`);
    return this.inner.phase(title);
  }

  log(message: string): void {
    this.inner.log(message);
  }

  decisionGate(request: DecisionGateRequest, phaseVisit: PhaseVisit | null): Promise<JsonObject> {
    this.#gates += 1;
    if (this.#gates > this.policy.maxGates) throw new WorkflowContractError(`脚本 decisionGate 声明超过 Policy 上限 ${this.policy.maxGates}。`);
    return this.inner.decisionGate(request, phaseVisit);
  }
}
