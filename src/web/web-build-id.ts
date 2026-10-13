import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * 返回桌面壳与 daemon 必须共同认可的 Web 构建指纹。
 *
 * 指纹只覆盖 Vite 入口 `index.html`：入口已经包含每个带 content hash 的 JS/CSS
 * 资源名，因此任一会影响加载契约的生产构建变化都会改变该值。它不是安全凭据，
 * 只用于拒绝桌面壳加载不属于同一构建的旧 daemon 页面。
 */
export function webBuildId(webDist: string): string {
  if (!isAbsolute(webDist)) throw new Error("Web 构建资源目录必须是绝对路径。 ");
  const entry = join(webDist, "index.html");
  const info = statSync(entry);
  if (!info.isFile()) throw new Error(`桌面 Web 入口不存在：${entry}`);
  return createHash("sha256").update(readFileSync(entry)).digest("hex");
}
