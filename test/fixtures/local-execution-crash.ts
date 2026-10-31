import { join } from "node:path";
import { LeadService } from "../../src/lead/service";
import { LeadExecutionService } from "../../src/lead/executions";
import { preflightLocalWorkflow } from "../../src/workflow/preflight-local";

// 子进程故障夹具：在Task关联耐久后、首次调度前真实退出；不使用真实模型或Worker。
const root = process.argv[2]!;
const state = join(root, "lead"), store = join(root, "runs");
const lead = new LeadService(state, async () => { throw Error("不创建模型"); }, undefined, async () => ({ fingerprint: "injected-lead-session" }), true);
const path = join(root, "workflow.ts"), checked = await preflightLocalWorkflow(path, root);
const task = await lead.startLocalTask(root, { projectId: "p", clientRequestId: "b6b5a241-5881-4ef7-811a-e4dcb89c9432", path, sourceHash: checked.sourceHash, input: {} });
await lead.acceptWorkflowRevision(task.leadRunId, 1);
const executions = new LeadExecutionService(lead, () => ({ executor: { execute: async () => { throw Error("派发前退出不应调用Worker"); } } }), {
  wireControl: () => { process.exit(73); },
}, state, store);
await executions.createExecution(task.leadRunId, 1, {});
throw Error("故障注入未触发");
