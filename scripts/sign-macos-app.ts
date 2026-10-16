import { existsSync } from "node:fs";
import { resolve } from "node:path";

const APP_IDENTIFIER = "com.wave-flow.desktop";
const ENGINE_IDENTIFIER = "com.wave-flow.desktop.engine";
const appPath = resolve("src-tauri/target/release/bundle/macos/Wave Flow.app");
const enginePath = resolve(appPath, "Contents/MacOS/wave-flow-desktop-engine");

if (process.platform !== "darwin") process.exit(0);
if (!existsSync(appPath) || !existsSync(enginePath)) throw new Error("macOS App 或 Desktop Engine 构建产物不存在，无法签名。");

/**
 * 开发机缺少 Developer ID 时使用 ad-hoc 身份，仅保证同一构建内主程序、Engine 和
 * Git 子进程统一归因。正式分发必须提供 APPLE_SIGNING_IDENTITY，才能跨版本稳定授权。
 */
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
// 不在此处静默启用 hardened runtime：Bun Engine 的 JIT entitlement 与公证须独立
// 验证。仅指定证书不代表已满足正式分发条件，不能把签名通过冒充公证通过。
const options = identity === "-" ? [] : ["--timestamp"];

run("xattr", ["-cr", appPath]);
run("codesign", ["--force", "--sign", identity, "--identifier", ENGINE_IDENTIFIER, ...options, enginePath]);
// 不使用 --deep 代替顺序签名：内嵌代码先签，外层最后封印资源与主程序身份。
run("codesign", ["--force", "--sign", identity, "--identifier", APP_IDENTIFIER, ...options, appPath]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

const appIdentity = capture("codesign", ["-dv", "--verbose=4", appPath]);
const engineIdentity = capture("codesign", ["-dv", "--verbose=4", enginePath]);
if (!appIdentity.split("\n").includes(`Identifier=${APP_IDENTIFIER}`)) throw new Error("外层 App 签名身份不一致。");
if (!engineIdentity.split("\n").includes(`Identifier=${ENGINE_IDENTIFIER}`)) throw new Error("Desktop Engine 签名身份不一致。");
const bundleIdentity = capture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", resolve(appPath, "Contents/Info.plist")]).trim();
if (bundleIdentity !== APP_IDENTIFIER) throw new Error("外层 App 的 Bundle ID 与签名身份不一致。");

if (identity === "-") {
  console.warn("已使用 ad-hoc 身份签名，App/Engine 身份及严格校验通过；首次权限弹窗行为仍需干净安装验收，正式发布前须验证 Developer ID、hardened runtime/JIT entitlement 与公证。");
}

function run(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command} 执行失败（exit ${result.exitCode}）。`);
}

function capture(command: string, args: string[]): string {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`${command} 执行失败：${output.trim()}`);
  return output;
}
