import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { runsRoot } from "../../src/journal/paths";

const roots: string[] = []; const daemons: LocalDaemon[] = [];
afterEach(async () => { daemons.splice(0).forEach(item => item.stop()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("Runtime API 只接受用户触发的空扫描请求，并且默认 runtime 为空", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-runtime-api-")); roots.push(root);
  const daemon = new LocalDaemon({ deterministicForTest: true, storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs") }); daemons.push(daemon); const server = daemon.start();
  await expect(fetch(`${server.baseUrl}/cli-runtimes`).then(response => response.json())).resolves.toEqual({ selectedByCli: {}, runtimes: [] });
  const invalid = await fetch(`${server.baseUrl}/cli-runtimes/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shell: "bad" }) });
  expect(invalid.status).toBe(400);
});
