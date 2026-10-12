import { resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../shared/json";

/** CLI 解析后的 run 命令；cwd 和 workflow 路径尚由 daemon 做最终 realpath 校验。 */
export type RunCommand = { readonly kind: "run"; readonly workflowPath: string; readonly cwd: string; readonly input: JsonObject };
/** CLI 解析后的 inspect 命令。 */
export type InspectCommand = { readonly kind: "inspect"; readonly runId: string };
/** 显式确保当前用户的全局 daemon 已健康启动；成功后立即退出。 */
export type StartCommand = { readonly kind: "start" };
export type ServeCommand = { readonly kind: "serve" };
/** 确保 daemon 后输出同源 Local Web 地址；不自动打开浏览器。 */
export type WebCliCommand = { readonly kind: "web" };
/** 显式优雅关闭已验证的当前用户 daemon；不会启动新 daemon。 */
export type CloseCliCommand = { readonly kind: "close" };
export type CompleteCommand = { readonly kind: "complete"; readonly argv: readonly string[] };
export type BlockCliCommand = { readonly kind: "block"; readonly argv: readonly string[] };
export type AnswerCliCommand = { readonly kind: "answer"; readonly argv: readonly string[] };
export type ContinueCliCommand = { readonly kind: "continue"; readonly argv: readonly string[] };
export type ResumeCliCommand = { readonly kind: "resume"; readonly runId: string };
export type PauseCliCommand = { readonly kind: "pause"; readonly runId: string };
export type RecoverCliCommand = { readonly kind: "recover"; readonly runId: string };
export type StopCliCommand = { readonly kind: "stop"; readonly runId: string };
export type CliCommand = RunCommand | InspectCommand | ResumeCliCommand | PauseCliCommand | RecoverCliCommand | StopCliCommand | StartCommand | ServeCommand | WebCliCommand | CloseCliCommand | CompleteCommand | BlockCliCommand | AnswerCliCommand | ContinueCliCommand | { readonly kind: "help" };

/** 解析 4.1 支持的 run / inspect / help 命令与参数。 */
export function parseCommand(argv: readonly string[], initialCwd: string): CliCommand {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (command === "complete") return { kind: "complete", argv: rest };
  if (command === "block") return { kind: "block", argv: rest };
  if (command === "answer") return { kind: "answer", argv: rest };
  if (command === "continue") return { kind: "continue", argv: rest };
  if (command === "resume") {
    const runId = rest[0];
    if (!runId || runId.startsWith("-") || rest.length !== 1) throw new Error("resume 命令需要唯一 run-id。 ");
    return { kind: "resume", runId };
  }
  if (command === "pause" || command === "recover" || command === "stop") {
    const runId = rest[0];
    if (!runId || runId.startsWith("-") || rest.length !== 1) throw new Error(`${command} 命令需要唯一 run-id。 `);
    return { kind: command, runId };
  }
  if (command === "start") { if (rest.length > 0) throw new Error("start 不接受参数。"); return { kind: "start" }; }
  if (command === "serve") { if (rest.length > 0) throw new Error("serve 不接受参数。"); return { kind: "serve" }; }
  if (command === "web") { if (rest.length > 0) throw new Error("web 不接受参数。"); return { kind: "web" }; }
  if (command === "close") { if (rest.length > 0) throw new Error("close 不接受参数。"); return { kind: "close" }; }
  if (command === "run") {
    const workflowPath = rest[0];
    if (!workflowPath || workflowPath.startsWith("-")) throw new Error("run 命令需要 Workflow 路径。");
    const options = parseOptions(rest.slice(1), initialCwd);
    return { kind: "run", workflowPath, cwd: options.cwd, input: options.input };
  }
  if (command === "inspect") {
    const runId = rest[0];
    if (!runId || runId.startsWith("-")) throw new Error("inspect 命令需要 run-id。");
    if (rest.slice(1).length > 0) throw new Error("inspect 不接受 --cwd；RunId 可直接定位用户级执行档案。");
    return { kind: "inspect", runId };
  }
  throw new Error(`未知命令：${command}`);
}

function parseOptions(argv: readonly string[], initialCwd: string): { cwd: string; input: JsonObject } {
  let cwd = initialCwd;
  let input: JsonObject = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--cwd") { const value = argv[++index]; if (!value) throw new Error("--cwd 需要路径。"); cwd = resolve(initialCwd, value); continue; }
    if (argv[index] === "--input") {
      const value = argv[++index]; if (!value) throw new Error("--input 需要 JSON 对象。");
      try { const parsed = JSON.parse(value) as unknown; if (!isJsonObject(parsed)) throw new Error(); input = parsed; } catch { throw new Error("--input 必须是 JSON-safe 对象。"); }
      continue;
    }
    throw new Error(`未知选项：${argv[index]}`);
  }
  return { cwd, input };
}
