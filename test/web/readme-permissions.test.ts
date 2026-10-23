import { expect, test } from "bun:test";

test("中英文用户文档说明原生CLI写例外及配置凭据风险", async () => {
  for (const path of ["README.md", "README.en.md"]) {
    const text = await Bun.file(path).text();
    expect(text).toContain("~/.codex");
    expect(text).toContain("~/.dsh");
    expect(text).toContain("~/.claude");
    expect(text).toContain("Kimi");
    expect(text).toContain(path === "README.md" ? "也可能被模型工具修改" : "model tools can also modify");
  }
  expect(await Bun.file(".gitignore").text()).toContain(".DS_Store");
});
