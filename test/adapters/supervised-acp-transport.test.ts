import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisedAcpTransport } from "../../src/adapters/acp-session";
import { launchMarkerPath, readLaunchState, reportPathFor, writerLaunchKey } from "../../src/runtimes/supervisor-report";

const PATH = process.env.PATH ?? "/bin:/usr/bin";
let reportDir = "";
let previous: string | undefined;

beforeAll(() => {
  reportDir = mkdtempSync(join(tmpdir(), "wf-supervised-"));
  previous = process.env.WF_SUPERVISOR_REPORT_DIR;
  process.env.WF_SUPERVISOR_REPORT_DIR = reportDir;
});

afterAll(() => {
  if (previous === undefined) delete process.env.WF_SUPERVISOR_REPORT_DIR;
  else process.env.WF_SUPERVISOR_REPORT_DIR = previous;
  rmSync(reportDir, { recursive: true, force: true });
});

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

test("supervised transport 报告 provider 组，close 后整组消失", async () => {
  const transport = await supervisedAcpTransport(
    { id: "fake-supervised", command: "bash", args: ["-c", "sleep 60"], env: { PATH } },
    new AbortController().signal,
  );
  const pgid = transport.writerProcess?.pid;
  expect(pgid).toBeGreaterThan(1);
  expect(groupExists(pgid!)).toBe(true);

  transport.close();
  await transport.exited.catch(() => undefined);
  expect(await waitFor(() => !groupExists(pgid!), 12_000)).toBe(true);
}, 30_000);

test("provider 异常退出经 supervisor 透传为非零", async () => {
  const transport = await supervisedAcpTransport(
    { id: "fake-supervised-exit", command: "bash", args: ["-c", "exit 9"], env: { PATH } },
    new AbortController().signal,
  );
  await expect(transport.exited).rejects.toThrow(/异常退出/);
}, 30_000);

test("supervised transport 按 launch key 写启动标记与 provider 报告", async () => {
  const key = writerLaunchKey("run-fence", "node-a", "session-a");
  const transport = await supervisedAcpTransport(
    { id: "fake-launch-report", command: "sleep", args: ["60"], env: { PATH, WF_WORKER_LAUNCH_KEY: key } },
    new AbortController().signal,
  );
  const path = reportPathFor(key);
  expect(await Bun.file(launchMarkerPath(path)).exists()).toBe(true);
  const state = await readLaunchState(path);
  expect(state.kind).toBe("provider");
  if (state.kind === "provider") {
    expect(state.pgid).toBe(transport.writerProcess!.pid);
    expect(state.startedAt.length).toBeGreaterThan(0);
  }
  transport.close();
  await transport.exited.catch(() => undefined);
  // 传输层不删除报告：恢复端仍需按同一路径找到 provider；由 finalize/围栏负责回收。
  expect(await Bun.file(path).exists()).toBe(true);
}, 30_000);
