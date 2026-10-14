/**
 * 以固定 argv `--version` 读取 CLI 版本摘要。
 * 必须模拟用户实际 CLI 环境的最小必要部分；许多用户安装器会通过 HOME 读取自身
 * 配置或解析 wrapper。仍然不继承任意 Engine 环境变量。label 只用于错误文案。
 */
export async function readCliVersion(path: string, label: string, extraPathDirectory?: string): Promise<string> {
  const env: Record<string, string> = { PATH: [...(extraPathDirectory ? [extraPathDirectory] : []), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":") };
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"] as const) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  // 成功时以 stdout 的首个非空行为权威版本；stderr 常含 PATH alias、临时目录
  // 等非版本警告，不得污染 Registry 展示或形成虚假的版本漂移。
  const value = (stdout.trim() || stderr.trim()).split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
  if (code !== 0 || !value || value.length > 500) throw new Error(`无法读取 ${label} 版本。 `);
  return value;
}
