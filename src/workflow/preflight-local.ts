import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import Ajv from "ajv";
import { validateWorkflowSource } from "./load-workflow";
import { validateWorkflowMeta } from "./validate-meta";
import type { WorkflowMeta } from "../shared/workflow-types";
import { isJsonObject, type JsonObject } from "../shared/json";

/** 本地无执行预检结果；验证只证明静态契约，不表示沙箱认证或执行许可。 */
export type LocalWorkflowPreflight = {
  /** Engine 派生请求身份；启动仍必须复核路径和源码 hash。 */
  readonly preflightId: string;
  /** realpath 项目目录；必须来自已验证 Project Store。 */
  readonly cwd: string;
  /** 项目内非软链接的常规 .ts 文件路径。 */
  readonly path: string;
  /** 本次读取字节的 SHA-256；绑定用户看见的版本。 */
  readonly sourceHash: string;
  /** 冻结源码；仅 Engine 内部保存，不执行或额外读取依赖。 */
  readonly source: string;
  /** 静态纯字面量元数据；用于方案预览。 */
  readonly meta: WorkflowMeta;
  /** Wave Flow 新增的 meta.inputSchema；新本地 Task 必填，不从 exampleArgs 猜测。 */
  readonly inputSchema: JsonObject;
};

const ajv = new Ajv({ allErrors: true, strict: false });

/** 项目内有界、非软链接、打开后 inode 对照读取；不 import、run、创建 Run/Worker 或写文件。 */
export async function preflightLocalWorkflow(path: string, cwd: string): Promise<LocalWorkflowPreflight> {
  const root = await realpath(cwd);
  // macOS /var 与 /private/var 可指向同一项目；先将原 cwd 前缀映射到 canonical root，
  // 不能对文件本身 realpath 后再检查，否则会隐藏文件软链接。
  const originalRoot = resolve(cwd);
  let candidate = resolve(originalRoot, path);
  // /var 是 macOS 系统级别的路径别名；只规范该已知前缀，不跟随项目内软链接。
  if (process.platform === "darwin" && candidate.startsWith("/var/")) candidate = resolve(await realpath("/var"), candidate.slice(5));
  const originalRelative = relative(originalRoot, candidate);
  const canonicalRelative = relative(root, candidate);
  const requested = isAbsolute(path) && !canonicalRelative.startsWith("..") && !isAbsolute(canonicalRelative)
    ? candidate : resolve(root, originalRelative);
  const within = relative(root, requested);
  if (!within || within.startsWith("..") || isAbsolute(within) || !requested.endsWith(".ts")) throw new Error("本地 Workflow 必须是项目内 .ts 文件。");
  let cursor = root;
  for (const part of within.split("/")) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("本地 Workflow 路径不允许软链接。");
  }
  const canonical = await realpath(requested);
  if (canonical !== requested) throw new Error("本地 Workflow 路径身份发生变化。");
  const before = await lstat(canonical);
  if (!before.isFile() || before.size > 200_000) throw new Error("本地 Workflow 必须是至多 200000 字节的常规文件。");
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 200_000) throw new Error("本地 Workflow 打开后身份不匹配。");
    const bytes = Buffer.alloc(200_001);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 200_000) throw new Error("本地 Workflow 超过读取上限。");
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytesRead !== opened.size) throw new Error("本地 Workflow 读取期间发生变化。");
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await handle.close(); }
  const checked = inspectLocalWorkflowSource(source, canonical);
  return { preflightId: crypto.randomUUID(), cwd: root, path: canonical, source, sourceHash: createHash("sha256").update(source).digest("hex"), ...checked };
}

/** 冻结源码的静态契约审计；Journal重开复用，不读磁盘、不import、不调用run。 */
export function inspectLocalWorkflowSource(source: string, fileName = "workflow.ts"): {readonly meta:WorkflowMeta;readonly inputSchema:JsonObject} {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics[0]) {
    const at = file.getLineAndCharacterOfPosition(diagnostics[0].start ?? 0);
    throw new Error(`本地 Workflow 语法错误 ${at.line + 1}:${at.character + 1}：${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`);
  }
  validateWorkflowSource(source, fileName);
  const statement = file.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "meta")) as ts.VariableStatement;
  const initializer = statement.declarationList.declarations[0]!.initializer!;
  const meta = literal(initializer);
  validateWorkflowMeta(meta);
  const schema = (meta as WorkflowMeta).inputSchema;
  if (!isJsonObject(schema) || schema.type !== "object") throw new Error("新本地 Workflow 必须声明 meta.inputSchema 对象 Schema。");
  // 输入必须是 JSON 对象。拒绝远端引用；AJV 无网络加载，所有引用必须静态可解释。
  ajv.compile(schema);
  return { meta, inputSchema: schema };
}

/** 只转换已通过纯字面量门禁的 AST，不 eval、不求值任何表达式。 */
function literal(node: ts.Node): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) throw new Error("meta 必须是静态字面量。");
    return [property.name.text, literal(property.initializer)];
  }));
  throw new Error("meta 不允许动态值。");
}

/** 新本地执行的输入校验；默认值不自动填充，Schema 错误或输入不符在加载代码之前拒绝。 */
export function validateLocalInput(schema: JsonObject, input: unknown): asserts input is JsonObject {
  if (!isJsonObject(input)) throw new Error("本地 Workflow 输入必须是 JSON 对象。");
  const validate = ajv.compile(schema);
  if (!validate(input)) throw new Error(`本地 Workflow 参数无效：${ajv.errorsText(validate.errors, { dataVar: "参数", separator: "；" })}`);
}
