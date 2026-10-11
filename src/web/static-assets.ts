import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize } from "node:path";

/** Vite 构建产物目录；生产 daemon 仅同源读取这里的静态文件。 */
const bundledWebDist = process.env.WF_WEB_DIST;
if (bundledWebDist !== undefined && !isAbsolute(bundledWebDist)) throw new Error("WF_WEB_DIST 必须是绝对目录。 ");
const webDist = bundledWebDist ?? new URL("./dist/", import.meta.url).pathname;

const mimeByExtension: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** 返回 Vite 的同源静态资源；API 路径必须在 daemon 路由层先处理。 */
export function serveWebAsset(pathname: string): Response | null {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!requested || requested.includes("\0")) return null;
  const normalized = normalize(requested);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  const path = join(webDist, normalized);
  if (!existsSync(path)) return pathname === "/" ? missingBuildResponse() : null;
  const info = statSync(path);
  if (!info.isFile()) return null;
  const contentType = mimeByExtension[extname(path)] ?? "application/octet-stream";
  return new Response(readFileSync(path), {
    headers: {
      "content-type": contentType,
      "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

function missingBuildResponse(): Response {
  return new Response("Wave Flow Local Web 尚未构建。请执行 bun run web:build。", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
