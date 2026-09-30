/**
 * 用户可以自行修正的命令行错误。
 *
 * main.ts 只对这类错误显示简洁提示；其他 Error 仍被视为未预期故障，保留原始信息
 * 以便开发者排查。这样不会把参数写错和程序故障混在一起。
 */
export class CliUsageError extends Error {
  /** @param message 面向命令使用者的具体修正提示。 */
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
