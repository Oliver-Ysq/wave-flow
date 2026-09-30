import { access } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowModule } from "../workflow/types";
import { CliUsageError } from "./errors";

/**
 * 动态导入用户明确指定的本地 TypeScript Workflow。
 *
 * @param workflowPath 相对或绝对的 .ts 文件路径。
 * @param baseDirectory 解析相对路径的目录；默认当前命令工作目录。
 * @returns 原样返回模块导出，meta 与入口的业务校验仍由 WorkflowRunner 负责。
 * @throws CliUsageError 扩展名不为 .ts、文件不存在或模块无法加载时抛出。
 */
export async function loadWorkflow(
  workflowPath: string,
  baseDirectory = process.cwd(),
): Promise<WorkflowModule> {
  const absolutePath = resolve(baseDirectory, workflowPath);
  if (extname(absolutePath) !== ".ts") {
    throw new CliUsageError(`Workflow 必须是 .ts 文件：${workflowPath}`);
  }

  try {
    await access(absolutePath);
  } catch {
    throw new CliUsageError(`找不到 Workflow 文件：${workflowPath}`);
  }

  try {
    return (await import(pathToFileURL(absolutePath).href)) as WorkflowModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`无法加载 Workflow：${workflowPath}\n${message}`);
  }
}
