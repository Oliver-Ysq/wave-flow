import ts from "typescript";
import { WorkflowContractError } from "../workflow/errors";
import type { ExecutionWorkspaceConfig } from "./execution-workspaces";

/** 静态写意图：字面量写节点 + 循环/批量写节点的稳定字面量前缀，不能用于推断并行依赖或执行AST。 */
export type WorkspaceWriteIntent = {
  /** 可直接枚举的写节点 id；授权按节点逐个核对。 */
  readonly nodeIds: readonly string[];
  /** 运行时生成 id 的写节点前缀；授权按前缀披露并核对，实际节点在封存时记录。 */
  readonly dynamicNodePrefixes: readonly string[];
  /** 存在无法静态核验的写意图；必须拒绝受管写。 */
  readonly uncertain: boolean;
};

/** 完全由字符串字面量组成的表达式求值；用于识别可枚举的固定 id。 */
function literalText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(expression.left);
    const right = literalText(expression.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

/** id 表达式的稳定前缀；`"repair-" + round`、`\`repair-${round}\`` 都以字面量开头，可静态披露。 */
function literalPrefix(expression: ts.Expression): string | null {
  const whole = literalText(expression);
  if (whole !== null) return whole;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // 先取左侧已知字面量（如 "a" + "b" + round 的前缀是 ab），再退回逐段前缀。
    const left = literalText(expression.left);
    return left !== null ? left : literalPrefix(expression.left);
  }
  if (ts.isTemplateExpression(expression)) return expression.head.text.length > 0 ? expression.head.text : null;
  return null;
}

/**
 * 只核对写意图声明，不执行AST。写节点 id 允许两类：
 * 1. 字符串字面量 → 逐个节点授权；
 * 2. 以字面量开头的表达式（循环追加轮次等）→ 按前缀授权，运行时实际 id 在封存时核验。
 * 只要 sandbox 不是字面量、选项不是内联对象、或 id 连稳定前缀都没有，就判 uncertain。
 */
export function readWorkspaceWriteIntent(source: string): WorkspaceWriteIntent {
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const ids = new Set<string>(), prefixes = new Set<string>(); let uncertain = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "agent") {
      const options = node.arguments[1];
      if (!options || !ts.isObjectLiteralExpression(options)) uncertain = true;
      else {
        let id: string | null = null, prefix: string | null = null, sandbox: string | null = "read-only";
        for (const property of options.properties) {
          // 展开可能覆盖前面的 id/sandbox，必须判定不确定。
          if (ts.isSpreadAssignment(property)) { uncertain = true; continue; }
          // 只有 id/sandbox 的简写会隐藏写授权；schema 等其余简写与写意图无关。
          if (ts.isShorthandPropertyAssignment(property)) {
            if (property.name.text === "id" || property.name.text === "sandbox") uncertain = true;
            continue;
          }
          if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) { uncertain = true; continue; }
          const key = property.name.text;
          if (key === "id") {
            const literal = literalText(property.initializer);
            if (literal !== null && literal.length > 0) id = literal;
            else {
              // 空字面量 id 本身非法；动态 id 必须有非空稳定前缀才可披露。
              const candidate = literal === null ? literalPrefix(property.initializer) : null;
              if (candidate !== null && candidate.length > 0) prefix = candidate;
            }
          }
          if (key === "sandbox") sandbox = ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
        }
        if (sandbox === null) uncertain = true;
        else if (sandbox === "workspace-write") {
          if (id !== null) { if (ids.has(id)) uncertain = true; ids.add(id); }
          else if (prefix !== null) prefixes.add(prefix);
          else uncertain = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { nodeIds: [...ids], dynamicNodePrefixes: [...prefixes], uncertain };
}

/** 是否存在需要受管Git授权的写意图（含无法核验的写声明）。 */
export function hasWorkspaceWriteIntent(intent: WorkspaceWriteIntent): boolean {
  return intent.nodeIds.length > 0 || intent.dynamicNodePrefixes.length > 0 || intent.uncertain;
}

/** 配置审批前/执行前使用同一写意图提取，不把展示预览当授权。 */
export function assertWorkspaceWriteIntent(source: string, config: ExecutionWorkspaceConfig): void {
  const { nodeIds, dynamicNodePrefixes, uncertain } = readWorkspaceWriteIntent(source);
  if (uncertain) throw new WorkflowContractError("首版受管写需要明确的字面量id/sandbox；动态id必须以可披露的字面量前缀开头，或改为固定节点。");
  const ids = new Set(nodeIds);
  const approved = config.authorization.nodes.map(node => node.nodeId);
  if (ids.size !== approved.length || approved.some(id => !ids.has(id))) throw new WorkflowContractError("Git成果授权与源码workspace-write节点不一致，拒绝给只读/未知节点授权。");
  const approvedPrefixes = (config.authorization.dynamicNodes ?? []).map(node => node.nodeIdPrefix);
  if (dynamicNodePrefixes.length !== approvedPrefixes.length || dynamicNodePrefixes.some(prefix => !approvedPrefixes.includes(prefix))) throw new WorkflowContractError("Git成果授权与源码动态写节点前缀不一致，拒绝给未披露的写节点授权。");
}
