import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { executeReadOnlyProjectQuery, readProjectFile } from "./shell-policy";

/** 为一个 Harness cwd 创建只读工具；工具定义不含写文件、Shell 或 Worker 操作。 */
export function createHarnessReadTools(cwd: string): AgentTool[] {
  return [
    {
      name: "read_project_file",
      label: "读取项目文件",
      description: "读取当前项目 cwd 内的一个常规文本文件或行范围。不能读取项目外路径、链接逃逸路径或大文件。",
      parameters: Type.Object({ path: Type.String({ description: "相对于项目 cwd 的文件路径" }), startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) }),
      execute: async (_id, params) => {
        const request = params as { path: string; startLine?: number; endLine?: number };
        const text = await readProjectFile(cwd, request);
        return { content: [{ type: "text", text }], details: { operation: "read_project_file", path: request.path } };
      },
      executionMode: "sequential",
    },
    {
      name: "query_project",
      label: "查询项目状态",
      description: "运行受限的只读项目查询。仅允许 pwd；特定 git status/log/branch/rev-parse；rg 搜索或列文件；ls 查看目录。参数必须是结构化 argv，不能写入或使用 shell 语法。",
      parameters: Type.Object({ command: Type.Union([Type.Literal("pwd"), Type.Literal("git"), Type.Literal("rg"), Type.Literal("ls")]), args: Type.Array(Type.String(), { maxItems: 12, description: "命令参数数组；不允许 shell 字符串" }) }),
      execute: async (_id, params, signal) => {
        const query = params as { command: "pwd" | "git" | "rg" | "ls"; args: string[] };
        const text = await executeReadOnlyProjectQuery(cwd, query, signal);
        return { content: [{ type: "text", text }], details: { operation: "query_project", command: query.command, args: query.args } };
      },
      executionMode: "sequential",
    },
  ];
}
