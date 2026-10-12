import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessService } from "../../src/harness/service";
import { DeterministicHarnessSession } from "../../src/harness/deterministic-session";

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

test("Harness MCP 只暴露只读工具与四个窄 action，越权工具明确拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-harness-mcp-")); roots.push(root); await writeFile(join(root, "package.json"), "{}\n");
  const service = new HarnessService(join(root, "harness"), async () => new DeterministicHarnessSession());
  const created = await service.create(root);
  const listed = await service.mcpTools(created.harnessRunId, { operation: "list", value: {} }) as { tools: Array<{ name: string }> };
  expect(listed.tools.map(item => item.name)).toEqual(["read_project_file", "query_project", "propose_workflow_revision", "inspect_execution", "read_run_capsule", "request_user_decision"]);
  expect(listed.tools.map(item => item.name)).not.toEqual(expect.arrayContaining(["complete", "create_worker", "write_file"]));
  await expect(service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "complete", arguments: {} } })).rejects.toThrow("未获授权");
  await expect(service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "read_project_file", arguments: { path: "package.json" } } })).resolves.toEqual({ text: "    1  {}\n    2  " });
});
