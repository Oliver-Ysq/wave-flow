import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadService } from "../../src/lead/service";
import { DeterministicLeadSession } from "../../src/lead/deterministic-session";

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

test("Lead MCP 只暴露四个窄控制工具，文件读取交给CLI原生工具", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-lead-mcp-")); roots.push(root); await writeFile(join(root, "package.json"), "{}\n");
  const service = new LeadService(join(root, "lead"), async () => new DeterministicLeadSession());
  const created = await service.create(root);
  const listed = await service.mcpTools(created.leadRunId, { operation: "list", value: {} }) as { tools: Array<{ name: string; inputSchema: Record<string, any> }> };
  // Kimi/Moonshot 在模型请求前校验每个属性，enum 不能替代显式 type。
  const checkTypes = (schema: Record<string, any>): void => {
    expect(typeof schema.type).toBe("string");
    for (const property of Object.values(schema.properties ?? {})) checkTypes(property as Record<string, any>);
    if (schema.items) checkTypes(schema.items);
  };
  for (const tool of listed.tools) checkTypes(tool.inputSchema);
  expect(listed.tools.map(item => item.name)).toEqual(["propose_workflow_revision", "inspect_execution", "read_run_capsule", "request_user_decision"]);
  expect(listed.tools.map(item => item.name)).not.toEqual(expect.arrayContaining(["complete", "create_worker", "write_file"]));
  await expect(service.mcpTools(created.leadRunId, { operation: "call", value: { name: "complete", arguments: {} } })).rejects.toThrow("未获授权");
  await expect(service.mcpTools(created.leadRunId, { operation: "call", value: { name: "read_project_file", arguments: { path: "package.json" } } })).rejects.toThrow("未获授权");
});
