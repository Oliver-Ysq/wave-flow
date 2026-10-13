import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildHarnessSystemPrompt } from "../../src/harness/harness-prompt";

const skillRoot = join(import.meta.dir, "../../skills/workflow-creator");

test("主控系统 prompt 内嵌 workflow-creator skill 全文", async () => {
  const prompt = buildHarnessSystemPrompt();
  // 行为边界在前。
  expect(prompt).toContain("propose_workflow_revision 只产生草案，用户接受后才可能创建 Execution");
  // skill 正文与两个 references 以附录形式拍平注入；磁盘上的 skill 文件是唯一事实来源。
  const guide = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const api = await readFile(join(skillRoot, "references/api.md"), "utf8");
  const patterns = await readFile(join(skillRoot, "references/patterns.md"), "utf8");
  const template = await readFile(join(skillRoot, "assets/workflow.restricted.txt"), "utf8");
  expect(prompt).toContain(guide.trim());
  expect(prompt).toContain(api.trim());
  expect(prompt).toContain(patterns.trim());
  // 主控只写受限草案，随 prompt 注入完整模板以锚定正确形状。
  expect(prompt).toContain(template.trim());
  // 拍平注入必须说明 references 链接已内联，避免主控试图读取不存在的磁盘路径。
  expect(prompt).toContain("附录完整附在最后");
});
