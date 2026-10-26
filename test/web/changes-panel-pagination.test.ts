import { expect, test } from "bun:test";
import { CHANGES_PAGE_SIZE, changesPageCount, changesPageSlice, clampChangesPage } from "../../src-tauri/web/src/changes-panel";

const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);

test("大清单按固定页大小切片，页数向上取整", () => {
  expect(changesPageCount(0)).toBe(1);
  expect(changesPageCount(CHANGES_PAGE_SIZE)).toBe(1);
  expect(changesPageCount(CHANGES_PAGE_SIZE + 1)).toBe(2);
  const all = paths(CHANGES_PAGE_SIZE * 2 + 7);
  expect(changesPageSlice(all, 0)).toEqual(all.slice(0, CHANGES_PAGE_SIZE));
  expect(changesPageSlice(all, 1)).toEqual(all.slice(CHANGES_PAGE_SIZE, CHANGES_PAGE_SIZE * 2));
  expect(changesPageSlice(all, 2)).toEqual(all.slice(CHANGES_PAGE_SIZE * 2));
  expect(changesPageSlice(all, 2)).toHaveLength(7);
});

test("页码越界收敛到合法范围；选择不随翻页失效", () => {
  const all = paths(CHANGES_PAGE_SIZE + 5);
  expect(clampChangesPage(all.length, -3)).toBe(0);
  expect(clampChangesPage(all.length, 99)).toBe(1);
  expect(changesPageSlice(all, 99)).toEqual(all.slice(CHANGES_PAGE_SIZE));
  // 选中文件在第 1 页，翻到第 2 页后仍是合法选择（存在于完整清单）。
  const selected = all[10]!;
  expect(all.includes(selected)).toBe(true);
  expect(changesPageSlice(all, 1).includes(selected)).toBe(false);
});

test("面板按页渲染而不是全量渲染，页导航显示真实总数", async () => {
  const panel = await Bun.file("src-tauri/web/src/changes-panel.tsx").text();
  expect(panel).not.toContain("review.paths.map(path =>");
  expect(panel).toContain("changesPageSlice(review.paths, currentPage)");
  expect(panel).toContain("{pagePaths.map(path =>");
  expect(panel).toContain('aria-label="上一页"');
  expect(panel).toContain('aria-label="下一页"');
  expect(panel).toContain("共 {review.paths.length.toLocaleString()} 个文件");
  expect(panel).toContain("{pageCount > 1 &&");
});

test("分页样式存在且固定在文件列底部", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain(".changes-panel .changes-pages { position:sticky; bottom:0;");
});
