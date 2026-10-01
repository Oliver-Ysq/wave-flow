import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentAdapter } from "../adapters/agent-adapter";
import { CodexCliAdapter } from "../adapters/codex-cli/codex-cli-adapter";
import { FakeAgentAdapter } from "../adapters/testing/fake-agent-adapter";
import { hashValue } from "../journal/hash";
import { RunJournal, runsDirectory } from "../journal/journal";
import type { RunManifest } from "../journal/types";
import { WorkflowRunner } from "../runtime/runner";
import type { CliAdapterName, ParsedRunCommand } from "./parse-run-command";
import { TerminalEventSink } from "./terminal-events";
import { loadWorkflow } from "./load-workflow";
import type { WorkflowModule } from "../workflow/types";

/** 根据 CLI adapter 名称创建后端；集中在此处避免 resume 与 run 的选择逻辑漂移。 */
export function createAdapter(adapter: CliAdapterName): AgentAdapter {
  return adapter === "fake" ? new FakeAgentAdapter("No critical findings.") : new CodexCliAdapter();
}

/** 为新 run 创建 manifest、Journal 并运行 Workflow。 */
export async function startRun(
  command: ParsedRunCommand,
  input: Record<string, unknown>,
  workflow: WorkflowModule,
): Promise<{ result: unknown; manifest: RunManifest }> {
  const workflowPath = resolve(command.workflowPath);
  const workflowHash = hashValue(await readFile(workflowPath, "utf8"));
  const runId = crypto.randomUUID();
  const manifest: RunManifest = {
    runId,
    workflowPath,
    workflowHash,
    input,
    adapter: command.adapter,
    cwd: command.cwd,
    createdAt: new Date().toISOString(),
  };
  const journal = await RunJournal.create(manifest, runsDirectory(process.cwd()));
  const runner = new WorkflowRunner({
    adapter: createAdapter(command.adapter),
    adapterId: command.adapter,
    events: new TerminalEventSink(),
    cwd: command.cwd,
    runId,
    journal,
  });
  return { result: await runner.run(workflow, input), manifest };
}

/** 恢复同一 run；脚本或环境身份变化会明确拒绝，绝不猜测回放。 */
export async function resumeRun(manifest: RunManifest): Promise<unknown> {
  const currentHash = hashValue(await readFile(manifest.workflowPath, "utf8"));
  if (currentHash !== manifest.workflowHash) {
    throw new Error("Workflow 源码已变化，无法恢复此 run。请使用原脚本，或启动新的 run。");
  }
  // RunJournal 已确保 workflowPath 位于当前项目；hash 一致后才 import，避免意外加载变化后的模块。
  const workflow = await loadWorkflow(manifest.workflowPath);
  const journal = await RunJournal.open(manifest.runId, runsDirectory(process.cwd()));
  const runner = new WorkflowRunner({
    adapter: createAdapter(manifest.adapter as CliAdapterName),
    adapterId: manifest.adapter,
    events: new TerminalEventSink(),
    cwd: manifest.cwd,
    runId: manifest.runId,
    journal,
  });
  return runner.run(workflow, manifest.input);
}
