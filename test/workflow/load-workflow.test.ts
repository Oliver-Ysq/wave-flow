import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow, validateWorkflowSource } from "../../src/workflow/load-workflow";
import { validateWorkflowMeta } from "../../src/workflow/validate-meta";

const directories: string[] = [];
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(source: string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-workflow-"));
  directories.push(root);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(packageRoot, join(root, "node_modules", "wave-flow"));
  const file = join(root, "workflow.ts");
  await writeFile(file, source, "utf8");
  return { root, file };
}

const validSource = `
import { agent } from "wave-flow";
export const meta = { name: "security-review", description: "Review source.", phases: [{ title: "scan" }], exampleArgs: { target: "src" } };
export default async function run(args: { target: string }) { void agent; return args.target; }
`;

describe("Workflow 文件加载", () => {
  test("接受 cwd 内带纯字面量 meta 的默认 async run(args) 模块", async () => {
    const { root, file } = await fixture(validSource);
    const loaded = await loadWorkflow<{ target: string }, string>(file, root);
    expect(loaded.meta).toMatchObject({ name: "security-review", phases: [{ title: "scan" }] });
    await expect(loaded.default({ target: "src" })).resolves.toBe("src");
    const loadedFromProjectRelativePath = await loadWorkflow<{ target: string }, string>("workflow.ts", root);
    await expect(loadedFromProjectRelativePath.default({ target: "src" })).resolves.toBe("src");
  });

  test("将作者 API 绑定到当前包入口，而非 Workflow 项目中的同名依赖", async () => {
    const { root, file } = await fixture(`
      import { phase } from "wave-flow";
      export const meta = { name: "bound-api", description: "Use the real author API.", phases: [{ title: "scan" }] };
      export default async function run(args: undefined) { phase("scan"); return args; }
    `);
    await rm(join(root, "node_modules", "wave-flow"), { recursive: true, force: true });
    await mkdir(join(root, "node_modules", "wave-flow"));
    await writeFile(join(root, "node_modules", "wave-flow", "package.json"), JSON.stringify({ type: "module", exports: "./index.ts" }), "utf8");
    await writeFile(join(root, "node_modules", "wave-flow", "index.ts"), "throw new Error('fake package was loaded');", "utf8");
    const loaded = await loadWorkflow(file, root);
    await expect(loaded.default(undefined)).rejects.toThrow("只能在正在执行的 Workflow 内");
  });

  test("在执行模块前拒绝非 TypeScript、项目外和链接逃逸路径", async () => {
    const { root } = await fixture(validSource);
    const outside = await fixture(validSource);
    await expect(loadWorkflow(join(root, "workflow.js"), root)).rejects.toThrow(".ts 文件");
    await expect(loadWorkflow(outside.file, root)).rejects.toThrow("必须位于项目 cwd 内");
    const nested = join(root, "nested");
    await mkdir(nested);
    await symlink(outside.file, join(nested, "outside.ts"));
    await expect(loadWorkflow(join(nested, "outside.ts"), root)).rejects.toThrow("cwd 外");
  });

  test("静态 meta 检查拒绝非顶部纯字面量与错误入口", () => {
    expect(() => validateWorkflowSource(`const shared = "x"; export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; export default async function run(args: unknown) {}`)).toThrow("第一条");
    expect(() => validateWorkflowSource(`export let meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; export default async function run(args: unknown) {}`)).toThrow("第一条");
    expect(() => validateWorkflowSource(`export const meta = { name, description: "x", phases: [{ title: "x" }] }; const name = "valid"; export default async function run(args: unknown) {}`)).toThrow("纯字面量");
    expect(() => validateWorkflowSource(`export const meta = { name: \`valid\`, description: "x", phases: [{ title: "x" }] }; export default async function run(args: unknown) {}`)).toThrow("纯字面量");
    expect(() => validateWorkflowSource(`export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; export async function run(args: unknown) {}`)).toThrow("默认导出");
    expect(() => validateWorkflowSource(`export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; export default function run(args: unknown) {}`)).toThrow("默认导出");
    expect(() => validateWorkflowSource(`import { helper } from "./helper"; export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; export default async function run(args: unknown) { return helper(args); }`)).toThrow("值导入目前只允许");
    expect(() => validateWorkflowSource(`export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; import type { Value } from "./types"; export default async function run(args: Value) {}`)).toThrow("import 必须位于 meta 之前");
    expect(() => validateWorkflowSource(`export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; export default async function run(args: unknown) { return import("./helper"); }`)).toThrow("不支持动态 import");
    expect(() => validateWorkflowSource(`export const meta = { name: "valid", description: "x", phases: [{ title: "x" }] }; console.log("side effect"); export default async function run(args: unknown) {}`)).toThrow("顶层只允许");
    expect(() => validateWorkflowSource(`export const meta = { name: "valid", description: ;`)).toThrow("语法无效");
  });

  test("动态值校验拒绝非法 meta 字段", () => {
    expect(() => validateWorkflowMeta({ name: "not kebab", description: "x", phases: [{ title: "x" }] })).toThrow("kebab-case");
    expect(() => validateWorkflowMeta({ name: "valid", description: "two\nlines", phases: [{ title: "x" }] })).toThrow("非空单行");
    expect(() => validateWorkflowMeta({ name: "valid", description: "x", phases: [{ title: "same" }, { title: "same" }] })).toThrow("必须唯一");
    expect(() => validateWorkflowMeta({ name: "valid", description: "x", phases: [{ title: "x" }], exampleArgs: [] })).toThrow("JSON-safe 对象");
    expect(() => validateWorkflowMeta({ name: "valid", description: "x", phases: [{ title: "x" }], value: Infinity })).toThrow("完全由 JSON-safe");
  });
});
