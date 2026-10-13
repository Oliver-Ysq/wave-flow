import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "../../src/workflow/load-workflow";
import { compileRestrictedWorkflow } from "../../src/workflow/restricted/restricted-runtime";

const assets = join(dirname(fileURLToPath(import.meta.url)), "../../skills/workflow-creator/assets");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// skill 模板是主控与作者复制改造的起点，必须通过当前真实校验门禁；
// 契约演进破坏模板时本测试失败，强制同步更新 skill。
test("受信任模板通过真实 loadWorkflow 加载与 meta 校验", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-skill-asset-")); directories.push(cwd);
  await writeFile(join(cwd, "workflow.ts"), await readFile(join(assets, "workflow.ts"), "utf8"), "utf8");
  const module = await loadWorkflow("workflow.ts", cwd);
  expect(module.meta.name).toBe("planned-workflow");
  expect(typeof module.default).toBe("function");
});

test("受限草案模板通过真实受限编译门禁", async () => {
  const module = compileRestrictedWorkflow(await readFile(join(assets, "workflow.restricted.txt"), "utf8"));
  expect(module.meta.name).toBe("planned-workflow");
  expect(typeof module.default).toBe("function");
});

test("SKILL.md 指向双模板，避免资产沉淀后不可发现", async () => {
  const guide = await readFile(join(assets, "../SKILL.md"), "utf8");
  expect(guide).toContain("assets/workflow.ts");
  expect(guide).toContain("assets/workflow.restricted.txt");
});
