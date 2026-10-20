import {expect,test} from "bun:test";
import {userFacingText} from "../../src-tauri/web/src/user-facing-text";

test("展示措辞不暴露内部主控角色，原输入保持不变",()=>{
  const diagnostic="主控已有运行回合。";
  expect(userFacingText(diagnostic)).toBe("Wave Flow 正在处理。");
  expect(diagnostic).toBe("主控已有运行回合。");
  expect(userFacingText("CLI 正在检查")).toBe("CLI 正在检查");
});
test("动态路径和外部错误不被角色措辞替换",()=>{
 const details="ENOENT /项目/主控配置.json；命令：读取主控配置";
 expect(userFacingText(details)).toBe(details);
 expect(userFacingText(`任务已创建，主控启动失败：${details}`)).toBe(`任务已创建，Wave Flow 连接失败：${details}`);
 expect(userFacingText("未知主控错误")).toBe("未知主控错误");
});
test("记录缺失不暴露 Run/manifest 内部词，并给出下一步",()=>{
  expect(userFacingText("指定 Run 不存在或 manifest 不可读取。")).toContain("记录已不存在或无法读取");
  expect(userFacingText("指定 Run 不存在或 manifest 不可读取。")).not.toContain("manifest");
  expect(userFacingText("指定 Harness Run 不存在或 manifest 不可读取。 ")).toContain("历史记录已不存在或无法读取");
});
