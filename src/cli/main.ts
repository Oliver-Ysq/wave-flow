#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { CodexCliAdapter } from "../adapters/codex-cli/codex-cli-adapter";
import { FakeAgentAdapter } from "../adapters/testing/fake-agent-adapter";
import { WorkflowRunner } from "../runtime/runner";
import { CliUsageError } from "./errors";
import { loadWorkflow } from "./load-workflow";
import { parseInputObject, parseRunCommand } from "./parse-run-command";
import { printError, printResult } from "./output";
import { TerminalEventSink } from "./terminal-events";

const HELP = `wave-flow CLI

Usage:
  wave-flow run <workflow-file> --adapter <fake|codex> [--input <json> | --input-file <path>] [--cwd <path>]

Examples:
  wave-flow run examples/hello-review.ts --adapter fake --input '{"target":"src"}'
  wave-flow run examples/hello-review.ts --adapter codex --input '{"target":"src"}'
  wave-flow run examples/hello-review.ts --adapter fake --input-file inputs/review.json
`;

/**
 * 执行 CLI 主流程。
 * @param argv 不含 Bun 可执行文件和脚本路径的用户参数；默认 Bun.argv.slice(2)。
 * @returns 0 表示成功，2 表示命令使用错误，1 表示 Workflow 或未预期执行错误。
 */
export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] !== "run") {
    return printError(new CliUsageError(`不支持的命令：${argv[0]}\n\n${HELP}`));
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  try {
    const command = parseRunCommand(argv.slice(1));
    const inputText = command.inputFile
      ? await readFile(command.inputFile, "utf8").catch(() => {
          throw new CliUsageError(`无法读取输入文件：${command.inputFile}`);
        })
      : command.inputText;
    const input = inputText === undefined ? {} : parseInputObject(inputText, command.inputFile ?? "--input");
    const workflow = await loadWorkflow(command.workflowPath);

    // Adapter 仅在 CLI 组装；Runner 与 Workflow 不需要知道当前使用 Fake 还是真实 Codex。
    const runner = new WorkflowRunner({
      adapter: command.adapter === "fake" ? new FakeAgentAdapter("No critical findings.") : new CodexCliAdapter(),
      events: new TerminalEventSink(),
      cwd: command.cwd,
    });
    printResult(await runner.run(workflow, input));
    return 0;
  } catch (error) {
    return printError(error);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
