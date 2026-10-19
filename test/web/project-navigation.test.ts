import { expect, test } from "bun:test";
import { droppedProjectPath } from "../../src-tauri/web/src/project-navigation";
test("生产组件回调在受控宿主下拒绝重入/提前创建，失败恢复且迟到目录不覆盖手输", async () => {
  const child = Bun.spawn([process.execPath, "test/fixtures/project-dialog-harness.ts"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect({ code: await child.exited, errors }).toEqual({ code: 0, errors: "" });
  expect(output).toContain("project-dialog async boundaries passed");
});
test("拖入只接纳单一绝对路径，不能从扩展名猜目录", () => {
  expect(droppedProjectPath(["/tmp/project"])).toBe("/tmp/project");
  expect(droppedProjectPath(["C:\\project"])).toBe("C:\\project");
  for (const paths of [[], ["/a", "/b"], ["relative"]]) expect(() => droppedProjectPath(paths)).toThrow();
});
test("项目两级折叠不导航，创建入口独立且拖入不自动提交", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const dialog = await Bun.file("src-tauri/web/src/project-create-dialog.tsx").text();
  expect(app).toContain('aria-controls="project-list"');
  expect(app).toContain('aria-label="创建项目"');
  expect(app).toContain('onClick={() => setExpanded(!expanded)}');
  expect(app).not.toContain('className="project-chevron"');
  expect(app).toContain('aria-controls={`project-tasks-${project.projectId}`}');
  expect(app).toContain('className="project-new-session"');
  expect(dialog).toContain("api.validateProjectPath(path)");
  expect(dialog).toContain("window.devicePixelRatio");
  expect(dialog).toContain("serial.current === token");
  expect(dialog).toContain("role=\"dialog\"");
  expect(dialog).toContain("directory: true, multiple: false");
  expect(dialog).toContain("submitting.current || validating.current || selecting.current || !cwd.trim()");
  expect(dialog).toContain("busy || checking || !cwd.trim()");
  expect(dialog).toContain("正在检查文件夹…");
  expect(dialog).toContain('setCwd("");');
  expect(dialog).toContain("submitting.current || validating.current");
  expect(dialog).toContain("disabled={busy || checking}");
  expect(dialog).toContain("selecting.current = true;");
  expect(dialog).toContain('finally { selecting.current = false; }');
});
