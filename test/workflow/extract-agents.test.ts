import { describe, expect, test } from "bun:test";
import { extractAgentWorkers } from "../../src/workflow/restricted/extract-agents";

describe("受限脚本 Worker 静态枚举", () => {
  test("loop 提示覆盖循环体与批量回调，不由动态 id 或循环初始化误判", () => {
    const { previewAgents } = extractAgentWorkers(`async function run(args) {
      await agent('普通', { id: args.id });
      for (let i = 0; i < 3; i++) await agent('for', { id: 'for' });
      for (const item of args.items) await agent('of', { id: item });
      for (const key in args.items) await agent('in', { id: key });
      while (args.more) { await agent('while', { id: 'while' }); break; }
      do { await agent('do', { id: 'do' }); } while (args.more);
      args.items.map(item => agent('map', { id: item }));
      args.items.forEach(function(item) { agent('each', { id: item }); });
      args.items.flatMap(item => [agent('flat', { id: item })]);
      args.items.map(item => () => agent('mapped-worker', { id: item }));
      args.items.map(item => { return () => agent('returned-worker', { id: item }); });
      for (let init = agent('init', { id: 'init' }); args.more;) break;
      for (const item of agent('iterable', { id: 'iterable' })) break;
      for (const item of args.items) { const deferred = () => agent('deferred', { id: 'deferred' }); }
      args.items.map(() => 1, agent('thisArg', { id: 'thisArg' }));
    }`);
    expect(previewAgents.map(item => item.loop)).toEqual([false, true, true, true, true, true, true, true, true, true, true, false, false, false, false]);
  });
  test("展示按调用位置枚举，不要求固定 id，循环只示意一次", () => {
    const result = extractAgentWorkers(`async function run(args) {
      phase('检查');
      for (const file of args.files) await agent('检查', { id: file, cli: 'kimi', label: '文件检查' });
      const options = { id: 'variable' };
      await agent('动态选项', options);
      await agent('固定', { id: 'fixed', cli: 'codex' });
      phase(args.title);
      await agent('复查', { id: 'fixed', label: '复查' });
    }`);
    expect(result.previewAgents.map(({ name, phaseTitle, cli }) => ({ name, phaseTitle, cli }))).toEqual([
      { name: '文件检查', phaseTitle: '检查', cli: 'kimi' },
      { name: 'Agent', phaseTitle: '检查', cli: null },
      { name: 'fixed', phaseTitle: '检查', cli: 'codex' },
      { name: '复查', phaseTitle: null, cli: null },
    ]);
    expect(new Set(result.previewAgents.map((item) => item.key)).size).toBe(4);
    expect(result.workers.map((item) => item.id)).toEqual(['fixed']);
    expect(result.dynamicCount).toBe(2);
  });
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
      { id: "a", cli: "codex", label: "甲工人", phaseTitle: "工作" },
      { id: "b", cli: "kimi", label: null, phaseTitle: "工作" },
      { id: "c", cli: null, label: null, phaseTitle: "工作" },
    ]);
    expect(dynamicCount).toBe(0);
  });
  test("字面量 cli 白名单已拓宽到 claude 与 dsh", () => {
    const { workers } = extractAgentWorkers(`async function run(args) {
  phase("工作");
  await agent("丙", { id: "c", cli: "claude" });
  await agent("丁", { id: "d", cli: "dsh" });
  await agent("戊", { id: "e", cli: "traex" });
}`);
    expect(workers).toEqual([
      { id: "c", cli: "claude", label: null, phaseTitle: "工作" },
      { id: "d", cli: "dsh", label: null, phaseTitle: "工作" },
      { id: "e", cli: null, label: null, phaseTitle: "工作" },
    ]);
  });

  test("按源码顺序记录 phase 归属；无前置 phase() 的节点为 null（未分阶段）", () => {
    const source = `const meta = { name: "x", description: "x", phases: [{ title: "验证" }, { title: "分析" }] };
async function run(args) {
  await agent("预热", { id: "early", cli: "kimi" });
  phase("验证");
  await agent("校验", { id: "v1", cli: "kimi" });
  phase("分析");
  await parallel([() => agent("并一", { id: "p1", cli: "codex" }), () => agent("并二", { id: "p2", cli: "codex" })]);
  phase("验证");
  await agent("复查", { id: "v2", cli: "kimi" });
}`;
    const { workers } = extractAgentWorkers(source);
    expect(workers.map((worker) => [worker.id, worker.phaseTitle])).toEqual([
      ["early", null],
      ["v1", "验证"],
      ["p1", "分析"],
      ["p2", "分析"],
      ["v2", "验证"],
    ]);
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
    expect(workers).toEqual([{ id: "static-1", cli: "codex", label: null, phaseTitle: "工作" }]);
    expect(dynamicCount).toBe(3);
  });

  test("动态 phase 标题不能沿用旧的静态归属", () => {
    const { workers } = extractAgentWorkers(`const meta = { name: 'x', description: 'x', phases: [{ title: '甲' }, { title: '乙' }] };
async function run(args) {
  phase('甲');
  await agent('一', { id: 'a', cli: 'kimi' });
  phase(args.title);
  await agent('二', { id: 'b', cli: 'kimi' });
}`);
    expect(workers.map((worker) => worker.phaseTitle)).toEqual(["甲", null]);
  });

  test("重复字面量 id 只保留首次出现", () => {
    const source = `const meta = { name: "x", description: "x", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  await agent("甲", { id: "a", cli: "codex" });
  await agent("乙", { id: "a", cli: "kimi" });
}`;
    const { workers, dynamicCount } = extractAgentWorkers(source);
    expect(workers).toEqual([{ id: "a", cli: "codex", label: null, phaseTitle: "工作" }]);
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
