import { expect, test } from "bun:test";
import { WriterProcessGroups } from "../../src/workspace/writer-process-group";

test("leader退出不代表整个writer组退出；迟到子进程阻止交接", async () => {
  let groupAlive = true, release!: () => void;
  const groups = new WriterProcessGroups(() => groupAlive);
  const identity = groups.register({ pid: 43210, exited: new Promise<void>(resolve => { release = resolve; }), terminate() {} });
  expect(groups.hasExited(identity)).toBe(false); release(); await Promise.resolve();
  expect(groups.hasExited(identity)).toBe(false);
  await expect(groups.closeAndVerify(identity, 30)).rejects.toThrow("未确认退出");
  groupAlive = false; await groups.closeAndVerify(identity, 30); expect(groups.hasExited(identity)).toBe(true);
  groupAlive = true; expect(groups.hasExited(identity)).toBe(true);
});
test("新Engine不认领旧证明身份，未知身份拒绝收尾", async () => {
  const original = new WriterProcessGroups(() => false);
  const identity = original.register({ pid: 43210, exited: Promise.resolve(), terminate() {} }); await Promise.resolve();
  expect(original.hasExited(identity)).toBe(true);
  const restarted = new WriterProcessGroups(() => false);
  expect(restarted.hasExited(identity)).toBe(false); await expect(restarted.closeAndVerify(identity)).rejects.toThrow("身份");
});
test("真实detached子进程终止后确认整个组已消失", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "exec /bin/sleep 30"], { detached: true, stdout: "ignore", stderr: "ignore" });
  const groups = new WriterProcessGroups(); const identity = groups.register({ pid: child.pid, exited: child.exited, terminate() { try { process.kill(-child.pid, "SIGTERM"); } catch {} } });
  try { expect(groups.hasExited(identity)).toBe(false); await groups.closeAndVerify(identity, 2_000); expect(groups.hasExited(identity)).toBe(true); }
  finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
});
