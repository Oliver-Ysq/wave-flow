/** 主页只读 Git 上下文；不作为执行授权或冻结基准。 */
export type ProjectContext = {
  /** 当前分支短名；非 Git、detached 或读取失败时为 null。 */ readonly branch: string | null;
  /** ready 为分支可读，detached 为游离 HEAD，unavailable 为非 Git 或读取失败。 */ readonly status: "ready" | "detached" | "unavailable";
};

/** 仅查询已登记项目的符号 HEAD；禁用锁和 fsmonitor，不读取工作文件。 */
export async function readProjectContext(cwd: string): Promise<ProjectContext> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") delete env[key];
  let child;
  try { child = Bun.spawn(["/usr/bin/git", "-c", "core.fsmonitor=false", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd, env, stdout: "pipe", stderr: "ignore",
  }); } catch { return { branch: null, status: "unavailable" }; }
  const timer = setTimeout(() => child.kill(), 2000);
  try {
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const branch = output.trim();
    return code === 0 && branch ? { branch, status: "ready" } : { branch: null, status: code === 1 ? "detached" : "unavailable" };
  } catch { return { branch: null, status: "unavailable" }; }
  finally { clearTimeout(timer); }
}
