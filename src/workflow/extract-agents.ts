import ts from "typescript";
import type { AgentCli } from "../shared/workflow-types";

/**
 * 从冻结作者模块源码静态枚举出的一个 Worker 声明；只有字面量 id 的 agent() 调用可被枚举。
 * 提取结果只用于分配卡与 config 校验，不代表脚本运行时一定创建该节点（控制流可能跳过）。
 */
export type ExtractedAgentWorker = {
  /** 脚本 agent() 选项中的字面量节点 id；Run 内唯一身份。 */
  readonly id: string;
  /** 字面量 cli 声明；未写死或非字面量时为 null（分配卡说了算，不直接生效）。 */
  readonly cli: AgentCli | null;
  /** 字面量展示名；未提供时为 null。 */
  readonly label: string | null;
  /**
   * 源码顺序上最近一次 phase() 调用的字面量标题；无前置阶段或动态标题时为 null（归属待运行时确定）。
   * 这是纯词法顺序事实，只用于计划卡预览分组，不代表运行时一定进入该 Phase（控制流可能跳过）。
   */
  readonly phaseTitle: string | null;
};

/** 单个 agent() 调用的展示示意；不要求固定 id，不用于执行分配或节点定位。 */
export type PreviewAgent = {
  /** 字面量节点id；动态为null，历史预览缺省。仅用于匹配配置，不作为授权。 */
  readonly nodeId?: string | null;
  /** 是否位于循环重复区域或常见批量遍历回调中；默认 false，仅源码提示，不证明次数或无限执行。 */
  readonly loop: boolean;
  /** 源码调用位置生成的稳定展示 key；只用于同一 revision 的列表，不是运行时 id。 */
  readonly key: string;
  /** 名称优先取非空字面量 label，其次固定 id，否则为 Agent；不猜测动态表达式值。 */
  readonly name: string;
  /** 字面量 CLI 提示；动态或未指定时为 null，由执行分配决定。 */
  readonly cli: AgentCli | null;
  /** 最近的字面量 phase 标题；null 表示归属待运行时确定，不是执行事实。 */
  readonly phaseTitle: string | null;
};

/** 一次静态提取的结果；执行分配名单与展示调用示意互相独立。 */
export type ExtractedAgentWorkers = {
  /** 每个源码 agent() 调用一个示意，循环不展开、不按名称或 id 去重。 */
  readonly previewAgents: readonly PreviewAgent[];
  /** 按源码出现顺序排列的字面量 Worker；重复字面量 id 只保留首次出现。 */
  readonly workers: readonly ExtractedAgentWorker[];
  /** 非字面量 id（模板串、变量、缺省 options）的 agent() 调用数；它们运行时落 default 分配。 */
  readonly dynamicCount: number;
};

/**
 * 用 TypeScript AST 扫描作者模块源码中的 agent(prompt, options) 调用。
 * 纯静态分析，不编译也不执行脚本：真实结果依赖控制流，dry-run 会枚举出错列表。
 */
export function extractAgentWorkers(source: string, fileName = "workflow.generated.ts"): ExtractedAgentWorkers {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const workers: ExtractedAgentWorker[] = [];
  const previewAgents: PreviewAgent[] = [];
  const seen = new Set<string>();
  let dynamicCount = 0;
  /** 源码顺序上最近一次 phase("...") 的字面量标题；AST 子节点按源码顺序遍历。 */
  let currentPhase: string | null = null;
  const visit = (node: ts.Node): void => {
    // 类型声明与类型节点在脱类型后不存在，整棵子树跳过。
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "phase") {
        const first = node.arguments[0];
        currentPhase = first && ts.isStringLiteral(first) ? first.text : null;
      } else if (node.expression.text === "agent") {
        const display = extractDisplayOptions(node.arguments[1]);
        previewAgents.push({ key: `call:${node.getStart(file)}`, nodeId:display.id, name: display.label?.trim() || display.id?.trim() || "Agent", cli: display.cli, phaseTitle: currentPhase, loop: isRepeatedCall(node) });
        const extracted = extractOptions(node.arguments[1]);
        if (extracted === null) dynamicCount += 1;
        else if (!seen.has(extracted.id)) {
          seen.add(extracted.id);
          workers.push({ ...extracted, phaseTitle: currentPhase });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return { workers, dynamicCount, previewAgents };
}

/** 只识别重复语法区域；跨普通函数边界停止，不追踪函数调用或证明成员方法的真实实现。 */
function isRepeatedCall(call: ts.CallExpression): boolean {
  let child: ts.Node = call;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isForStatement(parent) && (child === parent.statement || child === parent.condition || child === parent.incrementor)) return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && child === parent.statement) return true;
    if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return true;
    if (ts.isFunctionLike(parent)) {
      let callback: ts.Node = parent;
      while (callback.parent && ts.isParenthesizedExpression(callback.parent)) callback = callback.parent;
      const invocation = callback.parent;
      // map 常先生成 () => agent(...)，再交 parallel 调用；直接返回的函数仍属于批量示意。
      if (invocation && ts.isArrowFunction(invocation) && invocation.body === callback) continue;
      if (invocation && ts.isReturnStatement(invocation) && invocation.expression === callback) continue;
      if (!invocation || !ts.isCallExpression(invocation) || invocation.arguments[0] !== callback) return false;
      const member = invocation.expression;
      const name = ts.isPropertyAccessExpression(member) ? member.name.text
        : ts.isElementAccessExpression(member) && ts.isStringLiteral(member.argumentExpression) ? member.argumentExpression.text : null;
      return name !== null && ["map", "forEach", "flatMap", "filter", "some", "every", "reduce", "reduceRight"].includes(name);
    }
  }
  return false;
}

/** 只读展示字段独立提取；动态 id 不会使字面量 label/cli 消失，不求值变量或对象展开。 */
function extractDisplayOptions(argument: ts.Expression | undefined): { id: string | null; label: string | null; cli: AgentCli | null } {
  const display: { id: string | null; label: string | null; cli: AgentCli | null } = { id: null, label: null, cli: null };
  if (!argument || !ts.isObjectLiteralExpression(argument)) return display;
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
    if (name === "id" || name === "label") display[name] = property.initializer.text;
    else if (name === "cli" && (property.initializer.text === "codex" || property.initializer.text === "kimi" || property.initializer.text === "claude" || property.initializer.text === "dsh")) display.cli = property.initializer.text;
  }
  return display;
}

/** 读取 agent() 的第二个参数；只有对象字面量且 id 为字符串字面量时才可枚举。 */
function extractOptions(argument: ts.Expression | undefined): Omit<ExtractedAgentWorker, "phaseTitle"> | null {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null;
  let id: string | null = null;
  let cli: AgentCli | null = null;
  let label: string | null = null;
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === "id") {
      if (!ts.isStringLiteral(property.initializer)) return null;
      id = property.initializer.text;
    } else if (property.name.text === "cli" && ts.isStringLiteral(property.initializer) && (property.initializer.text === "codex" || property.initializer.text === "kimi" || property.initializer.text === "claude" || property.initializer.text === "dsh")) {
      cli = property.initializer.text;
    } else if (property.name.text === "label" && ts.isStringLiteral(property.initializer)) {
      label = property.initializer.text;
    }
  }
  return id === null || id.trim() === "" ? null : { id, cli, label };
}
