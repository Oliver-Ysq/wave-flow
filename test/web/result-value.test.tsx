import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultValue } from "../../src-tauri/web/src/execution/result-value";

test("字符串数组按行展开，不埋进原始 JSON", () => {
  const html = renderToStaticMarkup(
    createElement(ResultValue, {
      summary: { lines: ["第一行", "第二行", "第三行"] },
    }),
  );
  expect(html).toContain('<ol class="workflow-result-lines">');
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).toContain("第一行");
  expect(html).not.toContain("&quot;lines&quot;");
});

test("没有返回值时说明未保存，不伪造空列表", () => {
  const html = renderToStaticMarkup(createElement(ResultValue, { summary: null }));
  expect(html).toContain("这份记录未保存工作流返回结果。");
  expect(html).not.toContain("<ol");
});

test("非 lines 结构保留 JSON，保证信息不丢", () => {
  const html = renderToStaticMarkup(
    createElement(ResultValue, { summary: { ok: true, count: 2 } }),
  );
  expect(html).toContain("<pre>");
  expect(html).toContain("ok");
  expect(html).toContain("count");
});

test("结果页只呈现运行结果与节点结果，总结正文留在主控对话", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const start = app.indexOf('<section className="workflow-results">');
  const section = app.slice(start, app.indexOf("function ImpactSummaryNotice"));
  expect(section).toContain("<h2>运行结果</h2>");
  // 弹窗保留未完成总结的状态与停止/重试入口，但不渲染总结正文。
  expect(section).toContain("ImpactSummaryNotice");
  expect(section).not.toContain("aria-label=\"执行总结\"");
  expect(section).not.toContain("证据范围与限制");
  expect(section).not.toContain("const gitLimitation");
});
