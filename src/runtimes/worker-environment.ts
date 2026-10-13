import type { VerifiedCliRuntime } from "./types";
import { nodeRuntimeDirectory } from "./node-runtime";

/** 为 ACP Worker 构造最小环境；只允许有限的运行时与用户显式配置需求。 */
export function createWorkerEnvironment(runtime: VerifiedCliRuntime, controlCommand: string, inherited: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"] as const) if (inherited[key]) result[key] = inherited[key]!;
  for (const [key, value] of Object.entries(inherited)) if ((key.startsWith("LC_") || proxyOrCertificateKey(key)) && value) result[key] = value;
  result.PATH = normalizedPath(inherited.PATH, nodeRuntimeDirectory({ executablePath: runtime.nodeExecutable.path, executableIdentity: runtime.nodeExecutable.identity }));
  result.CODEX_PATH = runtime.executablePath;
  result.WAVE_FLOW_CONTROL_COMMAND = controlCommand;
  result.INITIAL_AGENT_MODE = "agent-full-access";
  result.NO_BROWSER = "1";
  return result;
}

function normalizedPath(value: string | undefined, nodeDirectory: string): string { const essential = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]; return [...new Set([nodeDirectory, ...(value?.split(":").filter(item => item.startsWith("/")) ?? []), ...essential])].join(":"); }
function proxyOrCertificateKey(key: string): boolean { return ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"].includes(key); }
