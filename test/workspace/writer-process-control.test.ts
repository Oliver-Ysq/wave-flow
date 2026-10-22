import { expect, test } from "bun:test";
import { captureWriterStartedAt, nodeWriterProcessControl } from "../../src/workspace/writer-process-control";

test.skipIf(process.platform !== "darwin")("真实进程组：指纹可读、SIGKILL 后确认消失", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "sleep 60"], { detached: true, stdout: "ignore", stderr: "ignore" });
  const pgid = child.pid;
  try {
    const startedAt = await captureWriterStartedAt(pgid);
    expect(startedAt.length).toBeGreaterThan(0);
    const control = nodeWriterProcessControl();
    // 同一个真实进程组：读到的指纹必须与绑定时一致，否则恢复会误判 PID 复用。
    expect(await control.probe(pgid)).toEqual({ state: "present", startedAt });
    await control.killGroup(pgid);
    const deadline = Date.now() + 5_000;
    let probe = await control.probe(pgid);
    while (probe.state !== "absent" && Date.now() < deadline) { await Bun.sleep(20); probe = await control.probe(pgid); }
    expect(probe.state).toBe("absent");
  } finally {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* 已退出 */ }
  }
});

test.skipIf(process.platform !== "darwin")("不存在的进程组按已退出处理，不产生误杀", async () => {
  const control = nodeWriterProcessControl();
  // 取一个几乎不可能存在的 pgid，避免碰到真实进程组。
  expect(await control.probe(2_000_000_000)).toEqual({ state: "absent" });
});
