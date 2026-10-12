import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { DeterministicHarnessSession } from "../../src/harness/deterministic-session";
import { runsRoot } from "../../src/journal/paths";

const directories: string[] = [];
const daemons: LocalDaemon[] = [];
const testHarness = async () => new DeterministicHarnessSession();
afterEach(async () => { daemons.splice(0).forEach((daemon) => daemon.stop()); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe.serial("Harness daemon API", () => {
  test("无本机模型密钥时创建 Harness fail closed，且不创建 Workflow Run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-api-")); directories.push(cwd);
    const store = await mkdtemp(join(tmpdir(), "wave-flow-harness-store-")); directories.push(store);
    const daemon = new LocalDaemon({ storeRoot: runsRoot(store) }); daemons.push(daemon); const server = daemon.start();
    const response = await fetch(`${server.baseUrl}/harness-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: crypto.randomUUID() }) });
    expect(response.status).toBe(400);
    await expect(fetch(`${server.baseUrl}/api/runs`).then((value) => value.json())).resolves.toEqual([]);
  });

  test("Harness API 拒绝错误请求，不暴露 Control 或 Worker 创建路径", async () => {
    const daemon = new LocalDaemon(); daemons.push(daemon); const server = daemon.start();
    expect((await fetch(`${server.baseUrl}/harness-runs/not-a-uuid/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status).toBe(400);
    expect((await fetch(`${server.baseUrl}/harness-runs/not-a-uuid/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });

  test("Harness 列表只返回独立耐久会话，不创建或扫描 Workflow Run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-list-")); directories.push(cwd);
    const root = await mkdtemp(join(tmpdir(), "wave-flow-harness-list-root-")); directories.push(root);
    const daemon = new LocalDaemon({ storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs") }); daemons.push(daemon); const server = daemon.start();
    const initial = await fetch(`${server.baseUrl}/api/harness-runs`).then((value) => value.json());
    expect(initial).toEqual({ harnesses: [] });
    const after = await fetch(`${server.baseUrl}/api/runs`).then((value) => value.json());
    expect(after).toEqual([]);
  });

  test("没有默认 Harness Runtime 时，首发会话 fail closed 且不落盘", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-runtime-required-")); directories.push(cwd);
    const root = await mkdtemp(join(tmpdir(), "wave-flow-harness-runtime-root-")); directories.push(root);
    const daemon = new LocalDaemon({ storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs") }); daemons.push(daemon); const server = daemon.start();
    const project = await fetch(`${server.baseUrl}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) }).then(value => value.json()) as { project: { projectId: string } };
    const started = await fetch(`${server.baseUrl}/projects/${project.project.projectId}/harness-messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.project.projectId, text: "不应落盘" }) });
    expect(started.status).toBe(400);
    await expect(fetch(`${server.baseUrl}/api/harness-runs`).then(value => value.json())).resolves.toEqual({ harnesses: [] });
  });

  test("Workflow 草案 API 只产生 Harness revision，不创建 Workflow Run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-revision-api-")); directories.push(cwd);
    const root = await mkdtemp(join(tmpdir(), "wave-flow-harness-revision-root-")); directories.push(root);
    const daemon = new LocalDaemon({ storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs"), createHarnessSession: testHarness }); daemons.push(daemon); const server = daemon.start();
    const previousHome = process.env.WAVE_FLOW_HOME; process.env.WAVE_FLOW_HOME = root;
    try {
      const project = await fetch(`${server.baseUrl}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) }).then(value => value.json()) as { project: { projectId: string } };
      const created = await fetch(`${server.baseUrl}/harness-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.project.projectId }) }).then(value => value.json()) as { harness: { harnessRunId: string } };
      const proposed = await fetch(`${server.baseUrl}/harness-runs/${created.harness.harnessRunId}/workflow-revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "export default async function run() {}" }) });
      expect(proposed.status).toBe(200);
      expect((await proposed.json() as { harness: { workflowRevisions: unknown[] } }).harness.workflowRevisions).toHaveLength(1);
      await expect(fetch(`${server.baseUrl}/api/runs`).then(value => value.json())).resolves.toEqual([]);
    } finally { if (previousHome === undefined) delete process.env.WAVE_FLOW_HOME; else process.env.WAVE_FLOW_HOME = previousHome; }
  });

  test("项目在侧边栏耐久，同项目可连续创建会话且旧 Harness 未归类", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-project-cwd-")); directories.push(cwd);
    const root = await mkdtemp(join(tmpdir(), "wave-flow-project-root-")); directories.push(root);
    const previousHome = process.env.WAVE_FLOW_HOME; process.env.WAVE_FLOW_HOME = root;
    try {
      const daemon = new LocalDaemon({ storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs"), createHarnessSession: testHarness }); daemons.push(daemon); const server = daemon.start();
      const project = await fetch(`${server.baseUrl}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "测试项目" }) }).then(value => value.json()) as { project: { projectId: string; cwd: string; title: string } };
      expect(project.project).toMatchObject({ cwd: await realpath(cwd), title: "测试项目" });
      const first = await fetch(`${server.baseUrl}/harness-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.project.projectId }) }).then(value => value.json()) as { harness: { projectId: string } };
      const second = await fetch(`${server.baseUrl}/harness-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.project.projectId }) }).then(value => value.json()) as { harness: { projectId: string } };
      expect(first.harness.projectId).toBe(project.project.projectId);
      expect(second.harness.projectId).toBe(project.project.projectId);
      await expect(fetch(`${server.baseUrl}/projects`).then(value => value.json())).resolves.toMatchObject({ projects: [{ projectId: project.project.projectId, title: "测试项目" }] });
    } finally { if (previousHome === undefined) delete process.env.WAVE_FLOW_HOME; else process.env.WAVE_FLOW_HOME = previousHome; }
  });

  test("新会话草稿不经 daemon 落盘，首次发送才创建唯一 Harness 并归属项目", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-first-message-cwd-")); directories.push(cwd);
    const root = await mkdtemp(join(tmpdir(), "wave-flow-harness-first-message-root-")); directories.push(root);
    const previousHome = process.env.WAVE_FLOW_HOME; process.env.WAVE_FLOW_HOME = root;
    try {
      const daemon = new LocalDaemon({ storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs"), createHarnessSession: testHarness }); daemons.push(daemon); const server = daemon.start();
      const project = await fetch(`${server.baseUrl}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "首发项目" }) }).then(value => value.json()) as { project: { projectId: string } };
      // UI 草稿不会调用任何创建接口；仅查看耐久列表必须保持为空。
      await expect(fetch(`${server.baseUrl}/api/harness-runs`).then(value => value.json())).resolves.toEqual({ harnesses: [] });
      const started = await fetch(`${server.baseUrl}/projects/${project.project.projectId}/harness-messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.project.projectId, text: "请先分析当前项目" }) });
      expect(started.status).toBe(200);
      const body = await started.json() as { harness: { harnessRunId: string; projectId: string; messages: Array<{ role: string; text: string }> } };
      expect(body.harness).toMatchObject({ projectId: project.project.projectId, messages: [{ role: "user", text: "请先分析当前项目" }] });
      for (let index = 0; index < 100; index += 1) { const state = await fetch(`${server.baseUrl}/harness-runs/${body.harness.harnessRunId}`).then(value => value.json()) as { harness: { status: string } }; if (state.harness.status === "idle") break; await Bun.sleep(2); }
      await expect(fetch(`${server.baseUrl}/api/harness-runs`).then(value => value.json())).resolves.toMatchObject({ harnesses: [{ harnessRunId: body.harness.harnessRunId, projectId: project.project.projectId }] });
      const mismatch = await fetch(`${server.baseUrl}/projects/${project.project.projectId}/harness-messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: crypto.randomUUID(), text: "不应创建" }) });
      expect(mismatch.status).toBe(400);
    } finally { if (previousHome === undefined) delete process.env.WAVE_FLOW_HOME; else process.env.WAVE_FLOW_HOME = previousHome; }
  });
});
