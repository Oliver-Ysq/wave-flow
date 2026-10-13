import { agent, log, parallel, phase } from "wave-flow";

export const meta = {
  name: "planned-workflow",
  description: "把目标拆解为独立任务，并行执行后汇总结论并落盘报告。",
  phases: [{ title: "计划" }, { title: "执行" }, { title: "汇总" }],
  exampleArgs: { objective: "比较三种方案并给出推荐", reportPath: "./report.md" },
};

type Args = { objective: string; reportPath?: string };
type Plan = { tasks: string[] };
type Report = { outputPath: string; summary: string };

/**
 * 受信任本地模块模板：计划 → 并行执行 → 汇总落盘。
 * 把这个模板的阶段、prompt 与输入输出替换成你的业务领域；不要增删顶层语句种类。
 * 注意：Workflow 代码自身不读写文件；产物由 workspace-write 的 Worker 落盘，
 * 脚本只传递路径与摘要。
 */
export default async function run(args: Args): Promise<Report> {
  phase("计划");
  log(`## 计划\n- **目标：** ${args.objective}`);
  const plan = await agent<Plan>(
    `把这个目标拆解为互相独立的任务清单：\n${args.objective}`,
    {
      id: "planner",
      cli: "codex",
      schema: {
        type: "object",
        properties: { tasks: { type: "array", items: { type: "string" }, minItems: 1 } },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
  );
  if (!plan) throw new Error("计划 Agent 未能交付结构化结果。");
  log(`### 计划就绪 — ${plan.tasks.length} 个任务`);

  phase("执行");
  log(`## 并行执行\n共 ${plan.tasks.length} 个任务，结果随完成逐个出现。`);
  const raw = await parallel(
    plan.tasks.map((task, index) => async () => {
      log(`- 开始 \`${task}\``);
      const finding = await agent(`完成这项独立任务：\n${task}`, { id: `task-${index + 1}`, cli: "codex" });
      if (finding) log(`- 完成 \`${task}\``);
      return finding;
    }),
  );
  const findings = raw.filter((item) => item !== null);

  phase("汇总");
  log(`## 汇总\n- 可用结果 ${findings.length}/${plan.tasks.length}`);
  const report = await agent<Report>(
    [
      `原始目标：${args.objective}`,
      `把以下任务结果汇总为一份简明报告，写入文件 ${args.reportPath ?? "./report.md"}；若该文件已存在则改用带序号的同名文件，绝不覆盖已有文件。返回实际写入路径与一段摘要。`,
      `任务结果：${JSON.stringify(findings)}`,
    ].join("\n\n"),
    {
      id: "synthesizer",
      cli: "codex",
      sandbox: "workspace-write",
      schema: {
        type: "object",
        properties: { outputPath: { type: "string" }, summary: { type: "string" } },
        required: ["outputPath", "summary"],
        additionalProperties: false,
      },
    },
  );
  if (!report) throw new Error("汇总 Agent 未能交付结构化结果。");
  log(`### 报告已保存\n- \`${report.outputPath}\``);
  return report;
}
