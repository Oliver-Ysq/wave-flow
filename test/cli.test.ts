import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../src/cli/errors";
import { loadWorkflow } from "../src/cli/load-workflow";
import { parseInputObject, parseRunCommand } from "../src/cli/parse-run-command";
import { TerminalEventSink } from "../src/cli/terminal-events";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CLI run command", () => {
  test("parses fake adapter, JSON input, and cwd", () => {
    const command = parseRunCommand(
      ["examples/hello-review.ts", "--adapter", "fake", "--input", '{"target":"src"}', "--cwd", "test"],
      "/project",
    );

    expect(command).toEqual({
      workflowPath: "examples/hello-review.ts",
      adapter: "fake",
      inputText: '{"target":"src"}',
      inputFile: undefined,
      cwd: "/project/test",
    });
    expect(parseInputObject(command.inputText!, "--input")).toEqual({ target: "src" });
  });

  test("rejects missing fake adapter and conflicting input sources", () => {
    expect(() => parseRunCommand(["workflow.ts"])).toThrow("必须明确指定 --adapter fake");
    expect(() => parseRunCommand(["workflow.ts", "--adapter", "fake", "--input", "{}", "--input-file", "input.json"])).toThrow(
      "不能同时使用",
    );
  });

  test("rejects invalid or non-object input JSON", () => {
    expect(() => parseInputObject("not json", "--input")).toThrow(CliUsageError);
    expect(() => parseInputObject("[]", "--input")).toThrow("必须是 JSON 对象");
  });

  test("loads a local TypeScript workflow but rejects non-TypeScript paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wave-flow-cli-"));
    temporaryDirectories.push(directory);
    const workflowPath = join(directory, "workflow.ts");
    await writeFile(workflowPath, 'export const meta = { name: "test-flow", description: "Test.", phases: ["test"], sideEffects: "none" }; export default async () => "ok";');

    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.meta.name).toBe("test-flow");
    await expect(loadWorkflow(join(directory, "workflow.js"))).rejects.toThrow("必须是 .ts 文件");
  });

  test("renders lifecycle events as readable terminal progress", () => {
    const lines: string[] = [];
    const events = new TerminalEventSink((line) => lines.push(line));

    events.emit({ type: "workflow.start", workflow: "hello-review", runId: "run-001" });
    events.emit({ type: "agent.started", label: "review", prompt: "Review src" , runId: "run-001" });
    events.emit({ type: "agent.completed", label: "review", runId: "run-001" });
    events.emit({ type: "workflow.end", workflow: "hello-review", runId: "run-001" });

    expect(lines).toEqual([
      "▶ Workflow started: hello-review",
      "  Run ID: run-001",
      "  → Agent started: review",
      "  ✓ Agent completed: review",
      "✓ Workflow completed: hello-review",
    ]);
  });
});
