import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWorkerSupervisorSpec, type WorkerSupervisorSpec } from "../../src/runtimes/worker-supervisor";

const moduleUrl = new URL("../../src/runtimes/worker-supervisor.ts", import.meta.url).pathname;
const entry = `import { runWorkerSupervisor } from ${JSON.stringify(moduleUrl)}; await runWorkerSupervisor();`;
const PATH = process.env.PATH ?? "/bin:/usr/bin";

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return await check();
}

async function readNumber(path: string): Promise<number | null> {
  try {
    const value = Number((await Bun.file(path).text()).trim().split("\n")[0]?.trim());
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch { return null; }
}

test("provider 退出码原样透传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-supervisor-"));
  try {
    const supervisor = Bun.spawn([process.execPath, "-e", entry], {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        WF_WORKER_SUPERVISOR_SPEC: encodeWorkerSupervisorSpec({
          command: "bash",
          args: ["-c", "exit 7"],
          cwd: tmpdir(),
          env: { PATH },
          ownerPid: process.pid,
          reportPath: join(dir, "pgid"),
        }),
      },
    });
    expect(await supervisor.exited).toBe(7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("owner 消失后 supervisor 终止整个 provider 组", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-supervisor-"));
  const reportPath = join(dir, "pgid");
  try {
    const owner = spawnOwner(dir, {
      command: "bash",
      args: ["-c", "sleep 60"],
      cwd: tmpdir(),
      env: { PATH },
      ownerPid: 0,
      reportPath: "",
    });
    const pgid = await waitFor(async () => (await readNumber(reportPath)) !== null, 10_000).then(async (ready) => {
      expect(ready).toBe(true);
      return (await readNumber(reportPath))!;
    });
    expect(groupExists(pgid)).toBe(true);
    // 报告文件第二行是 spawn 时同源采集的启动指纹；缺它时 Engine 只能事后补采。
    const report = (await Bun.file(reportPath).text()).trim().split("\n");
    expect(report).toHaveLength(2);
    expect(report[1]!.length).toBeGreaterThan(0);

    process.kill(owner.pid, "SIGKILL");
    expect(await waitFor(() => !groupExists(pgid), 12_000)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("owner 消失后，逃出进程组的后代也会被快照并终止", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-supervisor-"));
  const reportPath = join(dir, "pgid");
  const escapeeFile = join(dir, "escapee.pid");
  const provider = join(dir, "provider.sh");
  // 子进程用 setsid 自建会话/进程组，模拟工具调用里逃出 provider 组的孙进程。
  writeFileSync(provider, [
    "#!/bin/bash",
    `python3 -c 'import os,sys,time; os.setsid(); open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(60)' "$ESCAPEE_PID_FILE" &`,
    "sleep 60",
    "",
  ].join("\n"), { mode: 0o755 });
  try {
    const owner = spawnOwner(dir, {
      command: "bash",
      args: [provider],
      cwd: tmpdir(),
      env: { PATH, ESCAPEE_PID_FILE: escapeeFile },
      ownerPid: 0,
      reportPath: "",
    });
    const pgid = await waitFor(async () => (await readNumber(reportPath)) !== null, 10_000).then(async (ready) => {
      expect(ready).toBe(true);
      return (await readNumber(reportPath))!;
    });
    const escapee = await waitFor(async () => (await readNumber(escapeeFile)) !== null, 10_000).then(async (ready) => {
      expect(ready).toBe(true);
      return (await readNumber(escapeeFile))!;
    });
    expect(alive(escapee)).toBe(true);

    process.kill(owner.pid, "SIGKILL");
    expect(await waitFor(() => !alive(escapee), 12_000)).toBe(true);
    expect(groupExists(pgid)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

function spawnOwner(dir: string, spec: Omit<WorkerSupervisorSpec, "ownerPid" | "reportPath"> & { ownerPid: number; reportPath: string }) {
  const ownerScript = `
    const spec = JSON.parse(process.env.WF_SUP_SPEC);
    spec.ownerPid = process.pid;
    spec.reportPath = process.env.WF_SUP_REPORT;
    const payload = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
    Bun.spawn([process.execPath, "-e", process.env.WF_SUP_ENTRY], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, WF_WORKER_SUPERVISOR_SPEC: payload },
    });
    setInterval(() => {}, 1000);
  `;
  return Bun.spawn([process.execPath, "-e", ownerScript], {
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      WF_SUP_SPEC: JSON.stringify(spec),
      WF_SUP_ENTRY: entry,
      WF_SUP_REPORT: join(dir, "pgid"),
    },
  });
}
