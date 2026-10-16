import { join } from "node:path";
import { HarnessService } from "../../src/harness/service";
import { HarnessExecutionService } from "../../src/harness/executions";
import { preflightLocalWorkflow } from "../../src/workflow/preflight-local";

// 子进程故障夹具：在Task关联耐久后、首次调度前真实退出；不使用真实模型或Worker。
const root = process.argv[2]!;
const state = join(root, "harness"), store = join(root, "runs");
const harness = new HarnessService(state, async () => { throw Error("不创建模型"); }, undefined, async () => ({ fingerprint: "injected-harness-session" }), true);
const path = join(root, "workflow.ts"), checked = await preflightLocalWorkflow(path, root);
const task = await harness.startLocalTask(root, { projectId: "p", clientRequestId: "b6b5a241-5881-4ef7-811a-e4dcb89c9432", path, sourceHash: checked.sourceHash, input: {} });
await harness.acceptWorkflowRevision(task.harnessRunId, 1);
const executions = new HarnessExecutionService(harness, () => ({ executor: { execute: async () => { throw Error("派发前退出不应调用Worker"); } } }), {
  wireControl: () => { process.exit(73); },
}, state, store);
await executions.createExecution(task.harnessRunId, 1, {});
throw Error("故障注入未触发");
