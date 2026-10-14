import ts from "typescript";
import type { AgentCli } from "../../shared/workflow-types";

/**
 * 从冻结受限源码静态枚举出的一个 Worker 声明；只有字面量 id 的 agent() 调用可被枚举。
 * 提取结果只用于分配卡与 config 校验，不代表脚本运行时一定创建该节点（控制流可能跳过）。
 */
export type ExtractedAgentWorker = {
  /** 脚本 agent() 选项中的字面量节点 id；Run 内唯一身份。 */
  readonly id: string;
  /** 字面量 cli 声明；未写死或非字面量时为 null（分配卡说了算，不直接生效）。 */
  readonly cli: AgentCli | null;
  /** 字面量展示名；未提供时为 null。 */
  readonly label: string | null;
};

/** 一次静态提取的结果；动态 id Worker 不在列表中，只计入 dynamicCount 兜底展示。 */
export type ExtractedAgentWorkers = {
  /** 按源码出现顺序排列的字面量 Worker；重复字面量 id 只保留首次出现。 */
  readonly workers: readonly ExtractedAgentWorker[];
  /** 非字面量 id（模板串、变量、缺省 options）的 agent() 调用数；它们运行时落 default 分配。 */
  readonly dynamicCount: number;
};

/**
 * 用 TypeScript AST 扫描受限源码中的 agent(prompt, options) 调用。
 * 纯静态分析，不编译也不执行脚本：受限脚本的结果依赖控制流，dry-run 会枚举出错列表。
 */
export function extractAgentWorkers(source: string, fileName = "workflow.generated.ts"): ExtractedAgentWorkers {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const workers: ExtractedAgentWorker[] = [];
  const seen = new Set<string>();
  let dynamicCount = 0;
  const visit = (node: ts.Node): void => {
    // 类型声明与类型节点在脱类型后不存在，整棵子树跳过。
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "agent") {
      const extracted = extractOptions(node.arguments[1]);
      if (extracted === null) dynamicCount += 1;
      else if (!seen.has(extracted.id)) {
        seen.add(extracted.id);
        workers.push(extracted);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return { workers, dynamicCount };
}

/** 读取 agent() 的第二个参数；只有对象字面量且 id 为字符串字面量时才可枚举。 */
function extractOptions(argument: ts.Expression | undefined): ExtractedAgentWorker | null {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null;
  let id: string | null = null;
  let cli: AgentCli | null = null;
  let label: string | null = null;
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === "id") {
      if (!ts.isStringLiteral(property.initializer)) return null;
      id = property.initializer.text;
    } else if (property.name.text === "cli" && ts.isStringLiteral(property.initializer) && (property.initializer.text === "codex" || property.initializer.text === "kimi")) {
      cli = property.initializer.text;
    } else if (property.name.text === "label" && ts.isStringLiteral(property.initializer)) {
      label = property.initializer.text;
    }
  }
  return id === null || id.trim() === "" ? null : { id, cli, label };
}
