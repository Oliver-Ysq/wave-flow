import { CliUsageError } from "./errors";
import type { TerminalWriter } from "./terminal-events";

/** @param result Workflow 正常返回的值。@param write 输出目标，默认 console.log。 */
export function printResult(result: unknown, write: TerminalWriter = console.log): void {
  write("");
  write("Result:");
  write(JSON.stringify(result, null, 2));
}

/**
 * 输出错误并返回符合进程退出码语义的数字。
 * @param error CLI 使用错误或 Runtime 抛出的错误。
 * @param write 输出目标，默认 console.error。
 * @returns 使用错误返回 2，运行失败返回 1。
 */
export function printError(error: unknown, write: TerminalWriter = console.error): number {
  const message = error instanceof Error ? error.message : String(error);
  write(`错误：${message}`);
  return error instanceof CliUsageError ? 2 : 1;
}
