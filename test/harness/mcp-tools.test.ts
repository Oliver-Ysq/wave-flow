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
  const listed = await service.mcpTools(created.harnessRunId, { operation: "list", value: {} }) as { tools: Array<{ name: string; inputSchema: Record<string, any> }> };
  // Kimi/Moonshot 在模型请求前校验每个属性，enum 不能替代显式 type。
  const checkTypes = (schema: Record<string, any>): void => {
    expect(typeof schema.type).toBe("string");
    for (const property of Object.values(schema.properties ?? {})) checkTypes(property as Record<string, any>);
    if (schema.items) checkTypes(schema.items);
  };
  for (const tool of listed.tools) checkTypes(tool.inputSchema);
  expect(listed.tools.find(item => item.name === "query_project")?.inputSchema.properties.command).toEqual({ type: "string", enum: ["pwd", "git", "rg", "ls"] });
  expect(listed.tools.map(item => item.name)).toEqual(["read_project_file", "query_project", "propose_workflow_revision", "inspect_execution", "read_run_capsule", "request_user_decision"]);
  expect(listed.tools.map(item => item.name)).not.toEqual(expect.arrayContaining(["complete", "create_worker", "write_file"]));
  await expect(service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "complete", arguments: {} } })).rejects.toThrow("未获授权");
  const events: import("../../src/harness/types").HarnessStreamEvent[] = [];
  await service.subscribe(created.harnessRunId, event => events.push(event));
  await expect(service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "read_project_file", arguments: { path: "package.json" } } })).resolves.toEqual({ text: "    1  {}\n    2  " });
  expect(events).toEqual([
    expect.objectContaining({ type: "tool_started", label: "读取项目文件" }),
    expect.objectContaining({ type: "tool_finished", outcome: "completed" }),
  ]);
  expect((events[0] as { toolCallId: string }).toolCallId).toBe((events[1] as { toolCallId: string }).toolCallId);

  events.length = 0;
  await expect(service.mcpTools(created.harnessRunId, { operation: "call", value: { name: "read_project_file", arguments: { path: "missing.txt" } } })).rejects.toThrow();
  expect(events).toEqual([
    expect.objectContaining({ type: "tool_started", label: "读取项目文件" }),
    expect.objectContaining({ type: "tool_finished", outcome: "failed" }),
  ]);
  expect((events[0] as { toolCallId: string }).toolCallId).toBe((events[1] as { toolCallId: string }).toolCallId);
});
