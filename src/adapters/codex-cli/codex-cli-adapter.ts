import type { AgentAdapter, AgentExecutionInput } from "../agent-adapter";
import { extractAgentMessageFromLine } from "./jsonl-parser";
import type { CodexProcessResult } from "./types";

/** 运行 Codex 进程的可替换边界，使 JSONL 与失败语义能脱离真实登录态进行单元测试。 */
export type CodexProcessRunner = (input: AgentExecutionInput) => Promise<CodexProcessResult>;

/**
 * 将一次 Workflow Agent 节点映射为独立、只读的 `codex exec --json` 子进程。
 * 不使用 tmux：每次调用都有独立上下文和明确退出边界，后续由 wave-flow Journal 管理回放。
 */
export class CodexCliAdapter implements AgentAdapter {
  /** @param runProcess 可注入的进程执行器；省略时使用 Bun.spawn 启动本机 Codex CLI。 */
  constructor(private readonly runProcess: CodexProcessRunner = runCodexProcess) {}

  /**
   * @param input Runtime 提供的 prompt、label 与 cwd。
   * @returns Codex 最后一条 agent_message 文本。
   * @throws 非零退出、非法 JSONL 或缺少最终消息时抛出带有限 stderr 摘要的错误。
   */
  async execute(input: AgentExecutionInput): Promise<{ output: string }> {
    const result = await this.runProcess(input);
    const diagnostic = summarizeStderr(result.stderr);

    if (result.exitCode !== 0) {
      const parseDiagnostic = result.stdoutParseError ? ` stdout 解析错误：${result.stdoutParseError}` : "";
      throw new Error(`Codex 执行失败，退出码：${result.exitCode}${parseDiagnostic}${diagnostic}`);
    }

    if (result.stdoutParseError) {
      throw new Error(`Codex stdout JSONL 解析失败：${result.stdoutParseError}${diagnostic}`);
    }

    const output = result.finalMessage;
    if (output === undefined) {
      throw new Error(`Codex 已正常退出，但没有返回最终 agent_message。${diagnostic}`);
    }
    return { output };
  }
}

/**
 * 启动本机 Codex CLI。首切片固定 ephemeral + read-only，不能借此修改工作区。
 * @param input Runtime 规范化后的 Agent 任务。
 * @returns stdout JSONL、stderr 诊断和退出码。
 */
async function runCodexProcess(input: AgentExecutionInput): Promise<CodexProcessResult> {
  const process = Bun.spawn([
    "codex",
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    input.cwd,
    // 阻止以 -- 开头的任务文本被 Codex 解析成 CLI 选项。
    "--",
    input.prompt,
  ], {
    // exec 不应从 wave-flow 的终端继承 stdin；否则 Codex 会等待额外人类输入。
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutResult, stderr, exitCode] = await Promise.all([
    readFinalAgentMessage(process.stdout),
    readLimitedText(process.stderr, 800),
    process.exited,
  ]);
  return { ...stdoutResult, stderr, exitCode };
}

/**
 * 流式读取 stdout，只保留最后一条 agent_message，避免长工具日志占满内存。
 * JSONL 解析失败时仍持续 drain 到 EOF，确保子进程不会因写满管道阻塞或脱离管理。
 */
async function readFinalAgentMessage(
  stream: ReadableStream<Uint8Array>,
): Promise<Pick<CodexProcessResult, "finalMessage" | "stdoutParseError">> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let finalMessage: string | undefined;
  let stdoutParseError: string | undefined;

  function consumeLine(line: string): void {
    if (line.trim() === "") return;
    try {
      finalMessage = extractAgentMessageFromLine(line) ?? finalMessage;
    } catch (error) {
      // 只保留第一个错误，但绝不停止读取后续输出和进程收尾。
      stdoutParseError ??= error instanceof Error ? error.message : String(error);
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffered += decoder.decode();
  consumeLine(buffered);
  return { finalMessage, stdoutParseError };
}

/** 流式读取 stderr，只保留有限字符，避免诊断输出无限制占用内存。 */
async function readLimitedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (text.length < limit) text += decoder.decode(value, { stream: true }).slice(0, limit - text.length);
  }
  if (text.length < limit) text += decoder.decode().slice(0, limit - text.length);
  return text;
}

/** @param stderr Codex 原始 stderr。@returns 限长、单行化的诊断后缀，避免错误淹没终端。 */
function summarizeStderr(stderr: string): string {
  const normalized = stderr.trim().replace(/\s+/g, " ");
  if (normalized === "") return "";
  const limit = 800;
  return ` stderr: ${normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized}`;
}
