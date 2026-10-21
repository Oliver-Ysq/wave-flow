import { expect, test } from "bun:test";
import { assertAbsoluteMcpCommand } from "../../src/shared/mcp-server-command";

test("ACP stdio MCP server 只接受绝对 command（dsh 会显式拒绝相对路径）", () => {
  expect(() => assertAbsoluteMcpCommand({ name: "wave-flow-harness", command: "/opt/wave-flow/engine" })).not.toThrow();
  expect(() => assertAbsoluteMcpCommand({ name: "wave-flow-harness", command: "bun" })).toThrow("必须是绝对路径");
  expect(() => assertAbsoluteMcpCommand({ name: "wave-flow-worker-control", command: "./engine" })).toThrow("wave-flow-worker-control");
});
