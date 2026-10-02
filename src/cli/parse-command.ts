import { resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../shared/json";

/** CLI 解析后的 run 命令；cwd 和 workflow 路径尚由 daemon 做最终 realpath 校验。 */
export type RunCommand = { readonly kind: "run"; readonly workflowPath: string; readonly cwd: string; readonly input: JsonObject };
/** CLI 解析后的 inspect 命令。 */
export type InspectCommand = { readonly kind: "inspect"; readonly runId: string; readonly cwd: string };
export type CliCommand = RunCommand | InspectCommand | { readonly kind: "help" };

/** 解析 4.1 支持的 run / inspect / help 命令与参数。 */
export function parseCommand(argv: readonly string[], initialCwd: string): CliCommand {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") return { kind: "help" };
  if (command === "run") {
    const workflowPath = rest[0];
    if (!workflowPath || workflowPath.startsWith("-")) throw new Error("run 命令需要 Workflow 路径。");
    const options = parseOptions(rest.slice(1), initialCwd);
    return { kind: "run", workflowPath, cwd: options.cwd, input: options.input };
  }
  if (command === "inspect") {
    const runId = rest[0];
    if (!runId || runId.startsWith("-")) throw new Error("inspect 命令需要 run-id。");
    const options = parseOptions(rest.slice(1), initialCwd);
    return { kind: "inspect", runId, cwd: options.cwd };
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
