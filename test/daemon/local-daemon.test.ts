import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";

const directories: string[] = [];
const daemons: LocalDaemon[] = [];
afterEach(async () => { daemons.splice(0).forEach((daemon) => daemon.stop()); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture(): Promise<{ cwd: string; workflowPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-daemon-")); directories.push(cwd);
  const workflowPath = join(cwd, "workflow file.ts");
  await writeFile(workflowPath, `import { agent, phase } from "wave-flow";
export const meta = { name: "daemon-check", description: "Check daemon.", phases: [{ title: "scan" }] };
export default async function run(args: { target: string }) { phase("scan"); return agent("Review", { id: "scan-auth", cli: "codex", input: { target: args.target } }); }`, "utf8");
  return { cwd, workflowPath };
}

describe("LocalDaemon", () => {
  test("仅绑定 loopback，并经 API 创建 Journaled Run", async () => {
    const { cwd, workflowPath } = await fixture();
    const daemon = new LocalDaemon(); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    expect(baseUrl).toStartWith("http://127.0.0.1:");
    const response = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: { target: "src" } }) });
    const body = await response.json() as { runId: string; snapshot: { status: string; phases: Array<{ agents: Array<{ result: unknown }> }> } };
    expect(response.status).toBe(200);
    expect(body.runId).toBeString();
    expect(body.snapshot).toMatchObject({ status: "completed", phases: [{ agents: [{ result: { nodeId: "scan-auth" } }] }] });
    const inspect = await fetch(`${baseUrl}/runs/${body.runId}?cwd=${encodeURIComponent(cwd)}`);
    await expect(inspect.json()).resolves.toMatchObject({ runId: body.runId, snapshot: { status: "completed" } });
  });

  test("拒绝非 loopback API 约定的错误方法、Content-Type 与请求内容", async () => {
    const daemon = new LocalDaemon(); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    await expect(fetch(`${baseUrl}/runs`, { method: "GET" }).then((response) => response.status)).resolves.toBe(404);
    await expect(fetch(`${baseUrl}/runs`, { method: "POST", body: "{}" }).then((response) => response.status)).resolves.toBe(415);
    await expect(fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" }).then((response) => response.status)).resolves.toBe(400);
  });

  test("inspect 即使命中内存 Run 也要求请求 cwd 一致", async () => {
    const { cwd, workflowPath } = await fixture();
    const otherCwd = await mkdtemp(join(tmpdir(), "wave-flow-other-")); directories.push(otherCwd);
    const daemon = new LocalDaemon(); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    const created = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: { target: "src" } }) });
    const body = await created.json() as { runId: string };
    const inspect = await fetch(`${baseUrl}/runs/${body.runId}?cwd=${encodeURIComponent(otherCwd)}`);
    await expect(inspect.json()).resolves.toMatchObject({ error: "Run 不属于请求的项目 cwd。" });
    expect(inspect.status).toBe(400);
  });

  test("Workflow 运行中断后仍返回 RunId 和可 inspect 的 Journal 状态", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-daemon-")); directories.push(cwd);
    const workflowPath = join(cwd, "interrupted.ts");
    await writeFile(workflowPath, `import { agent } from "wave-flow";
export const meta = { name: "interrupted-flow", description: "Check interruption.", phases: [{ title: "scan" }] };
export default async function run(args: {}) { return agent("Review", { id: "scan", cli: "codex" }); }`, "utf8");
    const daemon = new LocalDaemon(); daemons.push(daemon);
    const { baseUrl } = daemon.start();
    const response = await fetch(`${baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowPath, cwd, input: {} }) });
    const body = await response.json() as { runId: string; snapshot: { status: string } };
    expect(response.status).toBe(200);
    expect(body.runId).toBeString();
    expect(body.snapshot.status).toBe("interrupted");
  });

});
