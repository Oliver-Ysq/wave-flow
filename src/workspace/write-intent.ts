import ts from "typescript";
import { WorkflowContractError } from "../workflow/errors";
import type { ExecutionWorkspaceConfig } from "./execution-workspaces";

/** 只核对明确字面量写意图与用户配置，不能用于推断并行依赖或执行AST。 */
export function readWorkspaceWriteIntent(source: string): { readonly nodeIds: readonly string[]; readonly uncertain: boolean } {
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const ids = new Set<string>(); let uncertain = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "agent") {
      const options = node.arguments[1];
      if (!options || !ts.isObjectLiteralExpression(options)) uncertain = true;
      else {
        let id: string | null = null, sandbox: string | null = "read-only";
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) { uncertain = true; continue; }
          const key = property.name.text;
          if (key === "id") id = ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
          if (key === "sandbox") sandbox = ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
        }
        if (sandbox === null || (sandbox === "workspace-write" && id === null)) uncertain = true;
        if (sandbox === "workspace-write" && id !== null) { if (ids.has(id)) uncertain = true; ids.add(id); }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { nodeIds: [...ids], uncertain };
}

/** 配置审批前/执行前使用同一写意图提取，不把展示预览当授权。 */
export function assertWorkspaceWriteIntent(source: string, config: ExecutionWorkspaceConfig): void {
  const { nodeIds, uncertain } = readWorkspaceWriteIntent(source);
  const ids = new Set(nodeIds);
  if (uncertain) throw new WorkflowContractError("首版受管写需要明确的字面量id/sandbox；动态写配置请改为可核验的固定节点。");
  const approved = config.authorization.nodes.map(node => node.nodeId);
  if (ids.size !== approved.length || approved.some(id => !ids.has(id))) throw new WorkflowContractError("Git成果授权与源码workspace-write节点不一致，拒绝给只读/未知节点授权。");
}
