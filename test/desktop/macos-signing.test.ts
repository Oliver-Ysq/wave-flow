import { expect, test } from "bun:test";

test("macOS 构建在交付前统一签名主程序与 Desktop Engine", async () => {
  const pkg = await Bun.file("package.json").json() as { scripts: Record<string,string> };
  const script = await Bun.file("scripts/sign-macos-app.ts").text();
  expect(pkg.scripts["desktop:build"]).toContain("scripts/sign-macos-app.ts");
  expect(script).toContain('const APP_IDENTIFIER = "com.wave-flow.desktop"');
  expect(script).toContain('const ENGINE_IDENTIFIER = "com.wave-flow.desktop.engine"');
  expect(script).toContain('run("xattr", ["-cr", appPath])');
  expect(script.indexOf('"--identifier", ENGINE_IDENTIFIER')).toBeLessThan(script.indexOf('"--identifier", APP_IDENTIFIER'));
  expect(script).toContain('"--verify", "--deep", "--strict"');
  expect(script).toContain("APPLE_SIGNING_IDENTITY");
  expect(script).toContain("Bundle ID 与签名身份不一致");
  expect(script).toContain("Tauri 在本脚本之前已经生成 dmg");
  expect(script).toContain('"-srcfolder", staging');
  expect(script).toContain('"-s", "/Applications"');
  expect(script).toContain('"-readonly", "-mountpoint", mountPoint, dmgPath');
  expect(script).toContain("dmg 内 App 的签名身份不一致");
  expect(script).toContain("dmg 缺少 Applications 安装入口");
});
