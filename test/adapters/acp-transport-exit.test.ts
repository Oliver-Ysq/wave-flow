import { afterEach, expect, test } from "bun:test";
import { bunAcpTransport } from "../../src/adapters/acp-session";

const previousHome = process.env.WAVE_FLOW_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.WAVE_FLOW_HOME;
  else process.env.WAVE_FLOW_HOME = previousHome;
});

test("adapter 退出立即 resolve，不被后代继承的 stderr 管道拖住", async () => {
  process.env.WAVE_FLOW_HOME = "/tmp/wf-acp-exit-probe";
  const transport = await bunAcpTransport({
    id: "exit-probe",
    command: "/bin/sh",
    // 后台 sleep 继承 stderr；若退出路径等待 stderr EOF，这里会至少延迟 1 秒。
    args: ["-c", "(sleep 1) & exit 0"],
  }, new AbortController().signal);
  const started = performance.now();
  try {
    await expect(transport.exited).resolves.toBe(0);
    expect(performance.now() - started).toBeLessThan(800);
  } finally {
    transport.close();
  }
});
