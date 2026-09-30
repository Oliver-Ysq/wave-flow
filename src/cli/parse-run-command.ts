import { resolve } from "node:path";
import { CliUsageError } from "./errors";

/** CLI MVP 唯一支持的执行器名称；真实 Codex 会在后续课程加入。 */
export type CliAdapterName = "fake";

/**
 * 解析完成、但尚未读取输入文件的 run 命令。
 * 保留 inputText / inputFile 的二选一关系，使文件 I/O 与纯参数解析可以分别测试。
 */
export type ParsedRunCommand = {
  /** 用户传入的 Workflow 路径；由 load-workflow.ts 再检查并导入。 */
  workflowPath: string;
  /** MVP 必填且当前只能为 fake，防止用户误以为实际调用了 Codex。 */
  adapter: CliAdapterName;
  /** 直接写在 --input 后的 JSON 文本；未提供时为 undefined。 */
  inputText?: string;
  /** --input-file 指向的 JSON 文件绝对路径；未提供时为 undefined。 */
  inputFile?: string;
  /** Agent 的工作目录绝对路径；省略时使用调用 CLI 时的当前目录。 */
  cwd: string;
};

/**
 * 将 run 子命令参数转为明确的结构，而不执行文件读取或 Workflow。
 *
 * @param argv 不含 `run` 本身的参数，例如 `["workflow.ts", "--adapter", "fake"]`。
 * @param baseDirectory 解析相对 --cwd 与 --input-file 路径的基准目录；测试可显式传入。
 * @returns 已检查命令形状和选项冲突的 ParsedRunCommand。
 * @throws CliUsageError 缺路径、缺 adapter、未知选项、选项缺值或输入来源冲突时抛出。
 */
export function parseRunCommand(argv: string[], baseDirectory = process.cwd()): ParsedRunCommand {
  const [workflowPath, ...options] = argv;
  if (!workflowPath || workflowPath.startsWith("-")) {
    throw new CliUsageError("缺少 Workflow 文件。用法：wave-flow run <workflow-file> --adapter fake");
  }

  let adapter: CliAdapterName | undefined;
  let inputText: string | undefined;
  let inputFile: string | undefined;
  let cwd = baseDirectory;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];

    if (option === "--adapter") {
      if (!value || value.startsWith("--")) throw new CliUsageError("--adapter 需要一个值，例如：--adapter fake");
      if (value !== "fake") throw new CliUsageError(`当前只支持 --adapter fake，收到：${value}`);
      adapter = value;
      index += 1;
      continue;
    }
    if (option === "--input") {
      if (value === undefined) throw new CliUsageError("--input 需要一个 JSON 对象。");
      inputText = value;
      index += 1;
      continue;
    }
    if (option === "--input-file") {
      if (!value || value.startsWith("--")) throw new CliUsageError("--input-file 需要一个 JSON 文件路径。");
      inputFile = resolve(baseDirectory, value);
      index += 1;
      continue;
    }
    if (option === "--cwd") {
      if (!value || value.startsWith("--")) throw new CliUsageError("--cwd 需要一个目录路径。");
      cwd = resolve(baseDirectory, value);
      index += 1;
      continue;
    }
    throw new CliUsageError(`不支持的选项：${option}`);
  }

  if (!adapter) throw new CliUsageError("MVP 阶段必须明确指定 --adapter fake。");
  if (inputText !== undefined && inputFile !== undefined) {
    throw new CliUsageError("--input 与 --input-file 不能同时使用。");
  }

  return { workflowPath, adapter, inputText, inputFile, cwd };
}

/**
 * 将 JSON 文本解析为 Workflow 的 args。
 * @param text 来自 --input 或 --input-file 的原始 JSON 文本。
 * @param source 出错时展示的来源名称，例如 `--input` 或具体文件路径。
 * @returns 只允许 JSON 对象；数组、null 和标量均被拒绝。
 */
export function parseInputObject(text: string, source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliUsageError(`${source} 不是合法 JSON。示例：--input '{"target":"src"}'`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`${source} 必须是 JSON 对象，例如：{"target":"src"}`);
  }
  return value as Record<string, unknown>;
}
