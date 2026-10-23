import { describe, expect, test } from "bun:test";
import { CLI_KINDS } from "../../src-tauri/web/src/cli-meta";

describe("设置页技能库与 CLI 入口", () => {
  test("暂时下线的 CLI 不进入前端可选种类，但保留展示元信息", async () => {
    expect(CLI_KINDS).toEqual(["codex", "claude", "dsh"]);
    const meta = await Bun.file("src-tauri/web/src/cli-meta.ts").text();
    expect(meta).toContain('kimi: { displayName: "Kimi CLI", icon: "K" }');
  });

  test("技能作为独立设置 tab，并支持 CLI 导入与 ZIP 导入", async () => {
    const app = await Bun.file("src-tauri/web/src/App.tsx").text();
    expect(app).toContain('<SkillsSettings />');
    expect(app).toContain('["skills", "技能"]');
    const component = await Bun.file("src-tauri/web/src/skills-settings.tsx").text();
    expect(component).toContain("添加技能");
    expect(component).toContain("从本机 CLI 导入");
    expect(component).toContain("上传 skill.zip");
    expect(component).toContain("api.skillsStatus()");
    expect(component).toContain("api.skillsDiscover()");
    expect(component).toContain("api.skillsImport(");
    expect(component).toContain("api.skillsImportZip(");
    expect(component).toContain("技能依赖未在当前 PATH 找到");
    expect(component).toContain("missingDependencies");
    expect(component).toContain("status.capabilities");
    expect(component).toContain("技能注入能力");
    expect(component).toContain("skills-capability-note");
    expect(component).toContain("status.unavailable");
    expect(component).toContain("status.invalid");
    expect(component).toContain("已暂停");
    expect(component).toContain("失败 ${failures.length} 个");
    expect(component).toContain("重新读取技能库");
    expect(component).toContain("重新扫描");
    expect(component).toContain("暂时无法读取本机技能目录");
  });
});
