import type { WorkflowExecutionHost } from "../runtime/workflow-host";
import { realpath, stat } from "node:fs/promises";
import type { WorkflowModule } from "../shared/workflow-types";
import { closeWorkflowContext, runWithWorkflowContext, waitForWorkflowOperations } from "./execution-context";

/** 在独立 AsyncLocalStorage 上下文中调用已验证 Workflow 的默认入口。 */
/** 执行作者 API 时固定的 Workflow 项目上下文；节点可显式选择独立绝对 cwd。 */
export type WorkflowExecutionOptions = {
  /** 本次 Run 的 Workflow 项目 cwd；必须存在，相对 Agent cwd 仅允许其真实子目录。 */
  readonly cwd?: string;
};

/** 在独立 AsyncLocalStorage 上下文中调用已验证 Workflow 的默认入口。 */
export async function executeWorkflow<Args, Result>(workflow: WorkflowModule<Args, Result>, args: Args, host: WorkflowExecutionHost, options: WorkflowExecutionOptions = {}): Promise<Result> {
  const cwd = await realpath(options.cwd ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error("Workflow Run 的 cwd 必须是目录。");
  return runWithWorkflowContext(workflow.meta, host, cwd, async () => {
    try {
      const result = await workflow.default(args);
      await waitForWorkflowOperations();
      return result;
    } finally {
      closeWorkflowContext();
    }
  });
}
