/** `--version` 探测超时时抛出的错误码；调用方据此区分“超时”与“程序不存在/退出失败”。 */
export const CLI_VERSION_TIMEOUT_CODE = "ETIMEDOUT";

/**
 * 以固定 argv `--version` 读取 CLI 版本摘要。
 * 必须模拟用户实际 CLI 环境的最小必要部分；许多用户安装器会通过 HOME 读取自身
 * 配置或解析 wrapper。仍然不继承任意 Engine 环境变量。label 只用于错误文案。
 * @param extraPathDirectories 需要排在系统目录之前的最小 PATH 目录（例如 node 所在目录）。
 * @param timeoutMs 单次探测预算；默认 5 秒。超时会杀掉子进程并抛出带
 *   `CLI_VERSION_TIMEOUT_CODE` 的错误，供候选探测区分超时与不可执行。
 */
export async function readCliVersion(path: string, label: string, extraPathDirectories: readonly string[] = [], timeoutMs = 5_000): Promise<string> {
  const env: Record<string, string> = { PATH: [...extraPathDirectories, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":") };
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"] as const) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1, timeoutMs));
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (timedOut) throw Object.assign(new Error(`读取 ${label} 版本超时。 `), { code: CLI_VERSION_TIMEOUT_CODE });
  // 成功时以 stdout 的首个非空行为权威版本；stderr 常含 PATH alias、临时目录
  // 等非版本警告，不得污染 Registry 展示或形成虚假的版本漂移。
  const value = (stdout.trim() || stderr.trim()).split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
  if (code !== 0 || !value || value.length > 500) throw new Error(`无法读取 ${label} 版本。 `);
  return value;
}
