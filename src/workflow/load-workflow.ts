import { realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { WorkflowModule } from "../shared/workflow-types";
import { validateWorkflowMeta } from "./validate-meta";

/** 从项目 cwd 内加载并验证一个受信任的 TypeScript Workflow 模块。 */
export async function loadWorkflow<Args = unknown, Result = unknown>(workflowPath: string, cwd: string): Promise<WorkflowModule<Args, Result>> {
  const projectRoot = await realpath(cwd);
  const requestedPath = resolve(projectRoot, workflowPath);
  if (!requestedPath.endsWith(".ts")) throw new Error("Workflow 文件必须是 .ts 文件。");
  let actualPath: string;
  try {
    actualPath = await realpath(requestedPath);
  } catch (error) {
    throw new Error(`无法读取 Workflow 文件：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPathWithin(projectRoot, actualPath)) throw new Error("Workflow 文件必须位于项目 cwd 内，且符号链接不得指向 cwd 外。");
  const source = await readFile(actualPath, "utf8");
  validateWorkflowSource(source, actualPath);
  const moduleSource = bindAuthorApiImport(source, actualPath);
  const moduleUrl = `data:text/typescript;base64,${Buffer.from(moduleSource, "utf8").toString("base64")}`;
  const loaded = await import(moduleUrl) as unknown;
  if (!loaded || typeof loaded !== "object") throw new Error("Workflow 模块必须导出对象。");
  const module = loaded as Record<string, unknown>;
  validateWorkflowMeta(module.meta);
  if (!isAsyncRun(module.default)) throw new Error("Workflow 必须默认导出 async function run(args)。");
  return { meta: module.meta, default: module.default as (args: Args) => Promise<Result> };
}

/** 将唯一允许的运行时作者 API 导入绑定到当前包入口，避免 Workflow cwd 的同名依赖劫持上下文。 */
function bindAuthorApiImport(source: string, fileName: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const authorApiUrl = new URL("../index.ts", import.meta.url).href;
  const replacements = file.statements
    .filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement)
      && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "wave-flow")
    .map((statement) => ({ start: statement.moduleSpecifier.getStart(file), end: statement.moduleSpecifier.getEnd(), value: JSON.stringify(authorApiUrl) }))
    .sort((left, right) => right.start - left.start);
  return replacements.reduce((result, replacement) => `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`, source);
}

/** 在执行 Workflow 代码前验证顶部 meta 与默认入口的静态形状。 */
export function validateWorkflowSource(source: string, fileName = "workflow.ts"): void {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) throw new Error("Workflow TypeScript 语法无效。");
  validateWorkflowImports(file);
  const statements = file.statements.filter((statement) => !ts.isImportDeclaration(statement));
  const metaStatement = statements[0];
  if (!metaStatement || !isExportedMeta(metaStatement)) {
    throw new Error("Workflow meta 必须是 imports 后第一条以 export const meta 声明的语句。");
  }
  const declaration = metaStatement.declarationList.declarations[0];
  if (!declaration.initializer || !isPureLiteral(declaration.initializer)) {
    throw new Error("Workflow meta 必须是纯字面量，不能包含变量、调用、展开、计算属性或模板字符串。");
  }
  const defaultExport = statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true);
  if (!defaultExport || !defaultExport.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || defaultExport.name?.text !== "run" || defaultExport.parameters.length !== 1) {
    throw new Error("Workflow 必须默认导出 async function run(args)。");
  }
  if (statements.some((statement) => statement !== metaStatement && statement !== defaultExport && !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement))) {
    throw new Error("Workflow 顶层只允许 import、meta、类型声明和默认 run(args)，不得执行其他语句。");
  }
}

function validateWorkflowImports(file: ts.SourceFile): void {
  let reachedNonImport = false;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      reachedNonImport = true;
      continue;
    }
    if (reachedNonImport) throw new Error("Workflow 的 import 必须位于 meta 之前。");
    if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error("Workflow import 的模块标识必须是字符串字面量。");
    if (!statement.importClause?.isTypeOnly && statement.moduleSpecifier.text !== "wave-flow") {
      throw new Error("Workflow 的值导入目前只允许来自 wave-flow；本地依赖图加载尚未实现。");
    }
  }
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error("Workflow 不支持动态 import()；本地依赖图加载尚未实现。");
    }
    ts.forEachChild(node, inspect);
  };
  ts.forEachChild(file, inspect);
}

function isExportedMeta(statement: ts.Statement): statement is ts.VariableStatement {
  if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  const declarations = statement.declarationList.declarations;
  return declarations.length === 1 && ts.isIdentifier(declarations[0].name) && declarations[0].name.text === "meta";
}

function isPureLiteral(expression: ts.Expression): boolean {
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || expression.kind === ts.SyntaxKind.TrueKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.every((element) => ts.isExpression(element) && isPureLiteral(element));
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.every((property) => {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return false;
    return (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) && isPureLiteral(property.initializer);
  });
  return false;
}

function isAsyncRun(value: unknown): value is (args: unknown) => Promise<unknown> {
  return typeof value === "function" && Object.getPrototypeOf(value).constructor.name === "AsyncFunction";
}

function isPathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
