import { resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../shared/json";

/** CLI 解析后的 run 命令；cwd 和 workflow 路径尚由 daemon 做最终 realpath 校验。 */
export type RunCommand = { readonly kind: "run"; readonly workflowPath: string; readonly cwd: string; readonly input: JsonObject; /** true 时经 App Server ACK 投递首条任务；默认 true。 */ readonly codexRpcInput: boolean };
/** CLI 解析后的 inspect 命令。 */
export type InspectCommand = { readonly kind: "inspect"; readonly runId: string };
/** CLI 解析后的 capabilities 命令；json 为 true 时输出机器可读快照。 */
export type CapabilitiesCommand = { readonly kind: "capabilities"; readonly json: boolean };
/** 显式确保当前用户的全局 daemon 已健康启动；成功后立即退出。 */
export type StartCommand = { readonly kind: "start" };
export type ServeCommand = { readonly kind: "serve" };
export type CompleteCommand = { readonly kind: "complete"; readonly argv: readonly string[] };
export type CliCommand = RunCommand | InspectCommand | CapabilitiesCommand | StartCommand | ServeCommand | CompleteCommand | { readonly kind: "help" };

/** 解析 4.1 支持的 run / inspect / help 命令与参数。 */
export function parseCommand(argv: readonly string[], initialCwd: string): CliCommand {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (command === "capabilities") {
    if (rest.length === 0) return { kind: "capabilities", json: false };
    if (rest.length === 1 && rest[0] === "--json") return { kind: "capabilities", json: true };
    throw new Error("capabilities 仅支持 --json 选项。");
  }
  if (command === "complete") return { kind: "complete", argv: rest };
  if (command === "start") { if (rest.length > 0) throw new Error("start 不接受参数。"); return { kind: "start" }; }
  if (command === "serve") { if (rest.length > 0) throw new Error("serve 不接受参数。"); return { kind: "serve" }; }
  if (command === "run") {
    const workflowPath = rest[0];
    if (!workflowPath || workflowPath.startsWith("-")) throw new Error("run 命令需要 Workflow 路径。");
    const options = parseOptions(rest.slice(1), initialCwd);
    return { kind: "run", workflowPath, cwd: options.cwd, input: options.input, codexRpcInput: options.codexRpcInput };
  }
  if (command === "inspect") {
    const runId = rest[0];
    if (!runId || runId.startsWith("-")) throw new Error("inspect 命令需要 run-id。");
    if (rest.slice(1).length > 0) throw new Error("inspect 不接受 --cwd；RunId 可直接定位用户级执行档案。");
    return { kind: "inspect", runId };
  }
  throw new Error(`未知命令：${command}`);
}

function parseOptions(argv: readonly string[], initialCwd: string): { cwd: string; input: JsonObject; codexRpcInput: boolean } {
  let cwd = initialCwd;
  let input: JsonObject = {};
  let codexRpcInput = true;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--cwd") { const value = argv[++index]; if (!value) throw new Error("--cwd 需要路径。"); cwd = resolve(initialCwd, value); continue; }
    if (argv[index] === "--input") {
      const value = argv[++index]; if (!value) throw new Error("--input 需要 JSON 对象。");
      try { const parsed = JSON.parse(value) as unknown; if (!isJsonObject(parsed)) throw new Error(); input = parsed; } catch { throw new Error("--input 必须是 JSON-safe 对象。"); }
      continue;
    }
    // App Server hybrid 是默认策略；保留旧开关为显式兼容别名。
    if (argv[index] === "--codex-rpc-input") { codexRpcInput = true; continue; }
    if (argv[index] === "--tmux-tui-input") { codexRpcInput = false; continue; }
    throw new Error(`未知选项：${argv[index]}`);
  }
  return { cwd, input, codexRpcInput };
}
