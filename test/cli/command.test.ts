import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { parseCommand } from "../../src/cli/parse-command";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("CLI run / inspect", () => {
  test("解析 run 输入、cwd 与 inspect", () => {
    expect(parseCommand(["run", "flow.ts", "--input", '{"target":"src"}', "--cwd", "project"], "/workspace")).toEqual({ kind: "run", workflowPath: "flow.ts", cwd: "/workspace/project", input: { target: "src" }, codexRpcInput: true });
    expect(parseCommand(["run", "flow.ts", "--codex-rpc-input"], "/workspace")).toMatchObject({ codexRpcInput: true });
    expect(parseCommand(["run", "flow.ts", "--tmux-tui-input"], "/workspace")).toMatchObject({ codexRpcInput: false });
    expect(parseCommand(["inspect", "11111111-1111-4111-8111-111111111111"], "/workspace")).toMatchObject({ kind: "inspect" });
    expect(() => parseCommand(["run", "flow.ts", "--input", "[]"], "/workspace")).toThrow("JSON-safe 对象");
    expect(parseCommand(["capabilities", "--json"], "/workspace")).toEqual({ kind: "capabilities", json: true });
    expect(() => parseCommand(["capabilities", "--cwd", "/workspace"], "/workspace")).toThrow("仅支持 --json");
  });

  test("capabilities --json 输出机器可读的三态快照", async () => {
    const lines: string[] = [];
    await main(["capabilities", "--json"], process.cwd(), (line) => { lines.push(line); });
    const snapshot = JSON.parse(lines.join("\n")) as { version: number; adapters: { codex: { verifiedPromptDelivery: string } } };
    expect(snapshot.version).toBe(1);
    expect(["available", "unavailable", "unknown"]).toContain(snapshot.adapters.codex.verifiedPromptDelivery);
  });

  test("run 通过 daemon 产生可渲染的开发验证 Run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-cli-")); directories.push(cwd);
    await writeFile(join(cwd, "workflow.ts"), `import { agent, phase } from "wave-flow";
export const meta = { name: "cli-check", description: "Check CLI.", phases: [{ title: "scan" }] };
export default async function run(args: {}) { phase("scan"); return agent("Review", { id: "scan", cli: "codex" }); }`, "utf8");
    const lines: string[] = [];
    await main(["run", "workflow.ts"], cwd, (line) => { lines.push(line); }, true);
    expect(lines.join("\n")).toContain("状态: completed");
    expect(lines.join("\n")).toContain("scan");
  });

  test("inspect 在新的短生命周期 daemon 中从 Journal 重建 Run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-cli-")); directories.push(cwd);
    await writeFile(join(cwd, "workflow.ts"), `import { agent, phase } from "wave-flow";
export const meta = { name: "inspect-check", description: "Check inspect.", phases: [{ title: "scan" }] };
export default async function run(args: {}) { phase("scan"); return agent("Review", { id: "scan", cli: "codex" }); }`, "utf8");
    const runLines: string[] = [];
    await main(["run", "workflow.ts"], cwd, (line) => { runLines.push(line); }, true);
    const runId = runLines.join("\n").split("\n")[0].replace("RunId: ", "");
    const inspectLines: string[] = [];
    await main(["inspect", runId], cwd, (line) => { inspectLines.push(line); }, true);
    expect(inspectLines.join("\n")).toContain(`RunId: ${runId}`);
    expect(inspectLines.join("\n")).toContain("状态: completed");
  });
});
