import { describe, expect, test } from "bun:test";
import { CodexCliAdapter } from "../src/adapters/codex-cli/codex-cli-adapter";
import { extractFinalAgentMessage } from "../src/adapters/codex-cli/jsonl-parser";

describe("Codex JSONL parser", () => {
  test("returns the last completed agent message and ignores unrelated events", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Draft"}}',
      '{"type":"turn.completed","usage":{"output_tokens":3}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Final answer"}}',
    ].join("\n");

    expect(extractFinalAgentMessage(stdout)).toBe("Final answer");
  });

  test("rejects malformed non-empty JSONL lines", () => {
    expect(() => extractFinalAgentMessage('{"type":"turn.started"}\nnot-json')).toThrow("无法解析");
  });
});

describe("CodexCliAdapter", () => {
  test("returns the final agent message from a successful process", async () => {
    const adapter = new CodexCliAdapter(async () => ({
      finalMessage: "OK",
      stderr: "warning only",
      exitCode: 0,
    }));

    await expect(adapter.execute({ prompt: "Reply", label: "test", cwd: "/workspace" })).resolves.toEqual({ output: "OK" });
  });

  test("includes limited stderr diagnostics when Codex exits unsuccessfully", async () => {
    const adapter = new CodexCliAdapter(async () => ({ finalMessage: undefined, stderr: "permission denied", exitCode: 23 }));

    await expect(adapter.execute({ prompt: "Reply", label: "test", cwd: "/workspace" })).rejects.toThrow(
      "退出码：23 stderr: permission denied",
    );
  });

  test("reports the exit code and stderr even when stdout parsing also failed", async () => {
    const adapter = new CodexCliAdapter(async () => ({
      finalMessage: undefined,
      stdoutParseError: "invalid JSONL",
      stderr: "process diagnostics",
      exitCode: 7,
    }));

    await expect(adapter.execute({ prompt: "Reply", label: "test", cwd: "/workspace" })).rejects.toThrow(
      "退出码：7 stdout 解析错误：invalid JSONL stderr: process diagnostics",
    );
  });

  test("reports a parse error after a successful process has been fully collected", async () => {
    const adapter = new CodexCliAdapter(async () => ({
      finalMessage: "ignored after malformed output",
      stdoutParseError: "Codex stdout 包含无法解析的 JSONL 事件。",
      stderr: "",
      exitCode: 0,
    }));

    await expect(adapter.execute({ prompt: "Reply", label: "test", cwd: "/workspace" })).rejects.toThrow("stdout JSONL 解析失败");
  });

  test("fails when a successful process has no final agent message", async () => {
    const adapter = new CodexCliAdapter(async () => ({ finalMessage: undefined, stderr: "", exitCode: 0 }));

    await expect(adapter.execute({ prompt: "Reply", label: "test", cwd: "/workspace" })).rejects.toThrow("没有返回最终 agent_message");
  });

  test("reports an oversized stdout line after draining the process", async () => {
    const adapter = new CodexCliAdapter(async () => ({
      finalMessage: undefined,
      stdoutParseError: "Codex stdout 单行超过 1048576 字符上限。",
      stderr: "",
      exitCode: 0,
    }));
    await expect(adapter.execute({ prompt: "Reply", label: "test", cwd: "/workspace" })).rejects.toThrow("stdout JSONL 解析失败");
  });
});
