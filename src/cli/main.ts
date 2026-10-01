#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { RunJournal, runsDirectory } from "../journal/journal";
import { CliUsageError } from "./errors";
import { loadWorkflow } from "./load-workflow";
import { parseInputObject, parseRunCommand } from "./parse-run-command";
import { printError, printResult } from "./output";
import { TerminalEventSink } from "./terminal-events";
import { resumeRun, startRun } from "./run-lifecycle";

const HELP = `wave-flow CLI

Usage:
  wave-flow run <workflow-file> --adapter <fake|codex> [--input <json> | --input-file <path>] [--cwd <path>]
  wave-flow resume <run-id>
  wave-flow inspect <run-id>

Examples:
  wave-flow run examples/hello-review.ts --adapter fake --input '{"target":"src"}'
  wave-flow run examples/hello-review.ts --adapter codex --input '{"target":"src"}'
  wave-flow run examples/hello-review.ts --adapter fake --input-file inputs/review.json
  wave-flow resume <run-id>
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
  if (argv[0] === "resume") return resumeCommand(argv.slice(1));
  if (argv[0] === "inspect") return inspectCommand(argv.slice(1));
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

    const { result, manifest } = await startRun(command, input, workflow);
    console.log(`Run ID: ${manifest.runId}`);
    printResult(result);
    return 0;
  } catch (error) {
    return printError(error);
  }
}

/** @param values resume 后的参数。@returns CLI 退出码。 */
async function resumeCommand(values: string[]): Promise<number> {
  const runId = values[0];
  if (!runId || values.length !== 1) {
    return printError(new CliUsageError("用法：wave-flow resume <run-id>"));
  }
  try {
    const journal = await RunJournal.open(runId, runsDirectory(process.cwd()));
    console.log(`▶ Resuming run: ${runId}`);
    printResult(await resumeRun(journal.manifest));
    return 0;
  } catch (error) {
    return printError(error);
  }
}

/** @param values inspect 后的参数。@returns CLI 退出码。 */
async function inspectCommand(values: string[]): Promise<number> {
  const runId = values[0];
  if (!runId || values.length !== 1) return printError(new CliUsageError("用法：wave-flow inspect <run-id>"));
  try {
    const journal = await RunJournal.open(runId, runsDirectory(process.cwd()));
    const { manifest } = journal;
    const summary = journal.summary();
    console.log(`Run: ${manifest.runId}`);
    console.log(`Workflow: ${manifest.workflowPath}`);
    console.log(`Adapter: ${manifest.adapter}`);
    console.log(`Created: ${manifest.createdAt}`);
    console.log(`Nodes: completed=${summary.completed}, replayed=${summary.replayed}, started=${summary.started}, failed=${summary.failed}`);
    if (summary.latestError) console.log(`Latest error: ${summary.latestError}`);
    return 0;
  } catch (error) {
    return printError(error);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
