import type { VerifiedCliRuntime } from "./types";
import { nodeRuntimeDirectory } from "./node-runtime";

/** 为 Codex ACP Worker 构造最小环境；只允许有限的运行时与用户显式配置需求。 */
export function createWorkerEnvironment(runtime: VerifiedCliRuntime, inherited: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const node = runtime.nodeExecutable;
  if (!node) throw new Error("Codex Worker 缺少已验证的 node 依赖，需要重新验证。 ");
  const result = inheritedWorkerEnvironment(inherited);
  result.PATH = normalizedPath(inherited.PATH, nodeRuntimeDirectory({ executablePath: node.path, executableIdentity: node.identity }));
  result.CODEX_PATH = runtime.executablePath;
  result.INITIAL_AGENT_MODE = "agent-full-access";
  result.NO_BROWSER = "1";
  return result;
}

/** Kimi CLI 自身即 ACP server；环境只有用户与证书白名单，不含 CODEX_PATH、node 或 Codex 会话模式。 */
export function createKimiWorkerEnvironment(_runtime: VerifiedCliRuntime, inherited: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const result = inheritedWorkerEnvironment(inherited);
  result.PATH = normalizedPath(inherited.PATH, null);
  result.NO_BROWSER = "1";
  return result;
}

/** 两种 CLI 共用继承白名单；CLI 专属变量仍由各自构造器添加，不扩大权限。 */
function inheritedWorkerEnvironment(inherited: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"] as const) if (inherited[key]) result[key] = inherited[key]!;
  for (const [key, value] of Object.entries(inherited)) if ((key.startsWith("LC_") || proxyOrCertificateKey(key)) && value) result[key] = value;
  return result;
}

function normalizedPath(value: string | undefined, nodeDirectory: string | null): string { const essential = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]; return [...new Set([...(nodeDirectory ? [nodeDirectory] : []), ...(value?.split(":").filter(item => item.startsWith("/")) ?? []), ...essential])].join(":"); }
function proxyOrCertificateKey(key: string): boolean { return ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"].includes(key); }
