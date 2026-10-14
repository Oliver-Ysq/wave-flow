import { describe, expect, test } from "bun:test";
import { extractAgentWorkers } from "../../src/workflow/restricted/extract-agents";

describe("受限脚本 Worker 静态枚举", () => {
  test("提取字面量 id/cli/label，按源码顺序排列", () => {
    const source = `const meta = { name: "x", description: "x", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  await agent("甲", { id: "a", cli: "codex", label: "甲工人" });
  await agent("乙", { id: "b", cli: "kimi" });
  await agent("丙", { id: "c" });
}`;
    const { workers, dynamicCount } = extractAgentWorkers(source);
    expect(workers).toEqual([
      { id: "a", cli: "codex", label: "甲工人" },
      { id: "b", cli: "kimi", label: null },
      { id: "c", cli: null, label: null },
    ]);
    expect(dynamicCount).toBe(0);
  });

  test("非字面量 id（模板串、变量、缺省 options）计入 dynamicCount 而不出现在列表", () => {
    const source = `const meta = { name: "x", description: "x", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  await agent("甲", { id: \`dyn-\${args.i}\`, cli: "codex" });
  await agent("乙", { id: args.name, cli: "kimi" });
  await agent("丙");
  await agent("丁", { id: "static-1", cli: "codex" });
}`;
    const { workers, dynamicCount } = extractAgentWorkers(source);
    expect(workers).toEqual([{ id: "static-1", cli: "codex", label: null }]);
    expect(dynamicCount).toBe(3);
  });

  test("重复字面量 id 只保留首次出现", () => {
    const source = `const meta = { name: "x", description: "x", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  await agent("甲", { id: "a", cli: "codex" });
  await agent("乙", { id: "a", cli: "kimi" });
}`;
    const { workers, dynamicCount } = extractAgentWorkers(source);
    expect(workers).toEqual([{ id: "a", cli: "codex", label: null }]);
    expect(dynamicCount).toBe(0);
  });

  test("嵌套在 parallel/条件分支中的 agent() 同样被枚举", () => {
    const source = `const meta = { name: "x", description: "x", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  if (args.more) await agent("分支", { id: "branch", cli: "kimi" });
  await parallel([() => agent("并一", { id: "p1", cli: "codex" }), () => agent("并二", { id: "p2", cli: "codex" })]);
}`;
    const { workers } = extractAgentWorkers(source);
    expect(workers.map((worker) => worker.id)).toEqual(["branch", "p1", "p2"]);
  });
});
