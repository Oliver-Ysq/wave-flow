import { expect, test } from "bun:test";
import { captureWriterStartedAt, fenceAcpWriter, nodeWriterProcessControl, type WriterProcessControl, type WriterProcessProbe } from "../../src/workspace/writer-process-control";

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

/** 用脚本化的 probe 序列模拟围栏判定，不依赖真实进程。 */
function scriptedControl(probes: readonly WriterProcessProbe[]): { control: WriterProcessControl; kills: number[] } {
  const kills: number[] = [];
  let index = 0;
  return {
    kills,
    control: {
      probe: async () => probes[Math.min(index++, probes.length - 1)]!,
      killGroup: async (pgid) => { kills.push(pgid); },
    },
  };
}

test("围栏：组不存在判已退出，不杀进程", async () => {
  const { control, kills } = scriptedControl([{ state: "absent" }]);
  expect(await fenceAcpWriter({ pgid: 4242, startedAt: "a" }, control)).toEqual({ outcome: "exited", reason: "进程组已不存在，原 provider 已退出。" });
  expect(kills).toEqual([]);
});

test("围栏：启动指纹不一致按 PID 复用处理，不误杀", async () => {
  const { control, kills } = scriptedControl([{ state: "present", startedAt: "other" }]);
  expect((await fenceAcpWriter({ pgid: 4242, startedAt: "a" }, control)).outcome).toBe("exited");
  expect(kills).toEqual([]);
});

test("围栏：指纹一致时终止整组并确认消失", async () => {
  const { control, kills } = scriptedControl([{ state: "present", startedAt: "a" }, { state: "absent" }]);
  expect(await fenceAcpWriter({ pgid: 4242, startedAt: "a" }, control)).toEqual({ outcome: "killed", reason: "已终止整个 provider 进程组并确认消失。" });
  expect(kills).toEqual([4242]);
});

test("围栏：无法核验时返回 unknown，调用方必须 fail closed", async () => {
  const { control, kills } = scriptedControl([{ state: "unknown", reason: "EPERM" }]);
  expect(await fenceAcpWriter({ pgid: 4242, startedAt: "a" }, control)).toEqual({ outcome: "unknown", reason: "EPERM" });
  expect(kills).toEqual([]);
});

test("围栏：终止后未在预算内消失返回 unknown", async () => {
  const { control } = scriptedControl([{ state: "present", startedAt: "a" }, { state: "present", startedAt: "a" }]);
  expect((await fenceAcpWriter({ pgid: 4242, startedAt: "a" }, control, 30)).outcome).toBe("unknown");
});

test("围栏：采集方式不同的指纹不能判成 PID 复用，必须 fail closed", async () => {
  // 记录侧是内核 `sec:usec`，探测侧退回 ps 文本：格式差异不等于换了一个进程。
  const { control, kills } = scriptedControl([{ state: "present", startedAt: "Wed Oct 22 09:00:02 2026" }]);
  expect(await fenceAcpWriter({ pgid: 4242, startedAt: "1792645200:363555" }, control)).toEqual({ outcome: "unknown", reason: "启动指纹采集方式不一致，无法核验是否同一进程组。" });
  expect(kills).toEqual([]);
});

test("围栏：同格式内核指纹不同仍按 PID 复用处理", async () => {
  const { control, kills } = scriptedControl([{ state: "present", startedAt: "1792645201:1" }]);
  expect((await fenceAcpWriter({ pgid: 4242, startedAt: "1792645200:363555" }, control)).outcome).toBe("exited");
  expect(kills).toEqual([]);
});
