import vm from "node:vm";
import ts from "typescript";
import type { JsonObject } from "../../shared/json";
import type { WorkflowModule } from "../../shared/workflow-types";
import { validateWorkflowMeta } from "../validate-meta";
import { validateRestrictedWorkflowSource } from "./validate-restricted-source";
import { createRestrictedHostBridge, RESTRICTED_BRIDGE_SOURCE, reviveContractError } from "./restricted-bridge";

/**
 * 把 Harness 生成脚本编译为受限 WorkflowModule。脚本永远不在宿主 realm 执行：
 * AST 白名单是第一道硬门，node:vm 独立 realm 与 JSON 膜桥接是第二、第三道。
 * 返回模块与 executeWorkflow 兼容，可复用 RunRuntime 的全部调度与恢复能力。
 */
export function compileRestrictedWorkflow(source: string): WorkflowModule<JsonObject, unknown> {
  validateRestrictedWorkflowSource(source);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    fileName: "workflow.generated.ts",
  }).outputText;

  const bridge = createRestrictedHostBridge();
  const sandbox: Record<string, unknown> = {
    __wf_call: bridge.call,
    __wf_parallel: bridge.parallel,
    __wf_pipeline: bridge.pipeline,
  };
  const context = vm.createContext(sandbox) as unknown as RestrictedContext;
  vm.runInContext(RESTRICTED_BRIDGE_SOURCE, context, { filename: "wave-flow/restricted-bridge.js" });
  // 尾注由 Runtime 控制：把脚本产物统一序列化为 JSON 字符串，宿主只接触字符串。
  const epilogue = `\n;globalThis.__wfMetaJson = JSON.stringify(meta);\nglobalThis.__wfRunJson = async (argsJson) => {\n  const value = await run(JSON.parse(argsJson));\n  return value === undefined ? "null" : JSON.stringify(value);\n};`;
  vm.runInContext(transpiled + epilogue, context, { filename: "workflow.generated.js" });

  const metaValue: unknown = JSON.parse(context.__wfMetaJson);
  validateWorkflowMeta(metaValue);
  return {
    meta: metaValue,
    default: async (args: JsonObject) => {
      let resultJson: string;
      try {
        resultJson = await context.__wfRunJson(JSON.stringify(args));
      } catch (error) {
        throw reviveContractError(error);
      }
      return JSON.parse(resultJson) as unknown;
    },
  };
}

/** vm realm 中由尾注与包装层写入的全局句柄；宿主只读取这两个字符串级入口。 */
type RestrictedContext = vm.Context & {
  /** 脚本 meta 的 JSON 字符串。 */
  readonly __wfMetaJson: string;
  /** 执行脚本 run(args)；入参与返回值均为 JSON 字符串。 */
  readonly __wfRunJson: (argsJson: string) => Promise<string>;
};
