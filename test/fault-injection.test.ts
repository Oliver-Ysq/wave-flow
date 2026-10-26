import { expect, test } from "bun:test";

test("故障注入：无响应 I/O、spawn 断电窗口与网络副作用恢复", async () => {
  const child = Bun.spawn([process.execPath, "scripts/fault-injection.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as {
    ok: boolean;
    scenarios: Array<Record<string, unknown>>;
  };
  expect(result.ok).toBe(true);
  expect(result.scenarios).toHaveLength(3);
  expect(result.scenarios[0]).toMatchObject({
    scenario: "unresponsive-io",
    ignoredSigterm: true,
    escalatedToSigkill: true,
    bounded: true,
  });
  expect(result.scenarios[1]).toMatchObject({
    scenario: "power-loss-spawn",
    rejectedResume: true,
    duplicateWriterPrevented: true,
  });
  expect(result.scenarios[2]).toMatchObject({
    scenario: "network-power-loss",
    beforeKill: 1,
    afterRestart: 1,
    afterExplicitResume: 2,
    noAutomaticRetry: true,
  });
}, 15_000);
