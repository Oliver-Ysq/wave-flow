import ts from "typescript";
import { isPureLiteral } from "../load-workflow";

/**
 * 受限 Runtime 允许脚本引用的全局标识符；它们由隔离桥注入，其余任何自由标识符
 * （process、Bun、fetch、Function、Object、Reflect、globalThis 等）都在编译前静态拒绝。
 * Math / Date / Promise 等标准内建同样不在白名单内：它们或破坏 replay 确定性，
 * 或不是脚本编排所必需。
 */
const ALLOWED_GLOBALS = new Set(["agent", "phase", "parallel", "pipeline", "log", "decisionGate", "JSON", "Error"]);

/** 禁止的成员名：封堵 obj.constructor.constructor 一类的 realm 逃逸链。 */
const BANNED_MEMBERS = new Set(["constructor", "prototype", "__proto__"]);

/**
 * 校验 Harness 生成脚本的受限 TypeScript 子集。这是受限 Runtime 的第一道硬门：
 * 任何拒绝都发生在脚本编译与执行之前。它不是模块——禁止一切 import/export，
 * 顶层只允许纯字面量 `const meta = {...}`、`async function run(args)` 与类型声明。
 */
export function validateRestrictedWorkflowSource(source: string, fileName = "workflow.generated.ts"): void {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) throw new Error(`受限 Workflow 脚本语法无效：${describeParseDiagnostic(source, parseDiagnostics[0])}`);
  // 先全树检查危险形态，再核对顶层形状，让 import/class 等给出准确诊断。
  const declared = collectDeclaredNames(file);
  validateTree(file, declared);
  validateTopLevelShape(file);
}

/**
 * 把编译器诊断改写为可行动文本：携带行列位置；"Invalid character" 附冒犯字符与码位。
 * 主控生成脚本时最常见的错误是混入中文引号或全角字符，诊断必须让它能精确自修。
 */
function describeParseDiagnostic(source: string, diagnostic: ts.Diagnostic): string {
  const base = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (typeof diagnostic.start !== "number") return base;
  const before = source.slice(0, diagnostic.start);
  const line = before.split("\n").length;
  const column = diagnostic.start - (before.lastIndexOf("\n") + 1) + 1;
  // 1127 = Invalid character；按诊断码而非文案判断，代理对按完整码位取字符。
  if (diagnostic.code === 1127) {
    const codePointValue = source.codePointAt(diagnostic.start);
    const char = codePointValue === undefined ? "" : String.fromCodePoint(codePointValue);
    const codePoint = codePointValue === undefined ? "未知" : `U+${codePointValue.toString(16).toUpperCase().padStart(4, "0")}`;
    return `${base}（第 ${line} 行第 ${column} 列：字符 ${JSON.stringify(char)}，码位 ${codePoint}）。常见原因是在字符串或标识符中混入中文引号或全角字符；脚本只允许 ASCII 引号与标点。`;
  }
  return `${base}（第 ${line} 行第 ${column} 列）`;
}

/** 顶层形状：无 import/export；恰好一个纯字面量 meta 与一个 async run(args)。 */
function validateTopLevelShape(file: ts.SourceFile): void {
  const statements = file.statements.filter((statement) => !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement));
  const metaStatement = statements[0];
  if (!metaStatement || !ts.isVariableStatement(metaStatement)) throw new Error("受限脚本第一条语句必须是 const meta = { … } 纯字面量声明。");
  if (metaStatement.modifiers?.length) throw new Error("受限脚本不是模块：meta 不得携带 export 等修饰符。");
  if ((metaStatement.declarationList.flags & ts.NodeFlags.Const) === 0) throw new Error("meta 必须使用 const 声明。");
  const declarations = metaStatement.declarationList.declarations;
  if (declarations.length !== 1 || !ts.isIdentifier(declarations[0].name) || declarations[0].name.text !== "meta") throw new Error("meta 声明必须恰好声明一个名为 meta 的常量。");
  if (!declarations[0].initializer || !isPureLiteral(declarations[0].initializer)) throw new Error("受限脚本 meta 必须是纯字面量，不能包含变量、调用、展开、计算属性或模板字符串。");
  const runStatement = statements[1];
  if (!runStatement || !ts.isFunctionDeclaration(runStatement) || runStatement.name?.text !== "run"
    || !runStatement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || runStatement.modifiers.some((modifier) => modifier.kind !== ts.SyntaxKind.AsyncKeyword)
    || runStatement.parameters.length !== 1 || runStatement.asteriskToken) {
    throw new Error("受限脚本必须在 meta 后声明 async function run(args)，且不得导出或携带其他修饰符。");
  }
  if (statements.length !== 2) throw new Error("受限脚本顶层只允许 meta 声明、async function run(args) 与类型声明。");
}

/** 收集脚本内声明过的全部标识符；引用检查只放行已声明名或全局白名单。 */
function collectDeclaredNames(file: ts.SourceFile): Set<string> {
  const declared = new Set<string>();
  const collectBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectBinding(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isVariableDeclaration(node)) collectBinding(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) declared.add(node.name.text);
    if (ts.isFunctionLike(node)) for (const parameter of node.parameters) collectBinding(parameter.name);
    if (ts.isCatchClause(node) && node.variableDeclaration) collectBinding(node.variableDeclaration.name);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return declared;
}

/** 全树检查：禁止危险语法形态，引用标识符必须已声明或在白名单内。 */
function validateTree(file: ts.SourceFile, declared: Set<string>): void {
  const visit = (node: ts.Node): void => {
    // 类型声明与类型节点在脱类型后完全消失，不参与运行时，整棵子树跳过。
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isImportEqualsDeclaration(node)) {
      throw new Error("受限脚本禁止一切 import/export；workflow API 由 Runtime 注入。");
    }
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) throw new Error("受限脚本禁止一切 import/export；workflow API 由 Runtime 注入。");
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) throw new Error("受限脚本禁止 class。");
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) throw new Error("受限脚本禁止 this/super。");
    if (ts.isMetaProperty(node)) throw new Error("受限脚本禁止 import.meta 等 meta property。");
    if (ts.isLabeledStatement(node)) throw new Error("受限脚本禁止标签语句。");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error("受限脚本禁止动态 import()。");
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.asteriskToken) throw new Error("受限脚本禁止 generator 函数。");
    if (ts.isPropertyAccessExpression(node) && BANNED_MEMBERS.has(node.name.text)) throw new Error(`受限脚本禁止访问 ${node.name.text} 成员。`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && BANNED_MEMBERS.has(node.argumentExpression.text)) throw new Error(`受限脚本禁止访问 ${node.argumentExpression.text} 成员。`);
    if (ts.isIdentifier(node) && isReference(node) && !declared.has(node.text) && !ALLOWED_GLOBALS.has(node.text)) {
      throw new Error(`受限脚本禁止引用未注入的标识符：${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
}

/** 判断标识符是否处于"值引用"位置；声明名、属性名、类型位置不算引用。 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) || ts.isPropertySignature(parent)) return false;
  if ((ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  return true;
}
