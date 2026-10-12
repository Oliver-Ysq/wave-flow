import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { runsRoot } from "../../src/journal/paths";

const directories: string[] = [];
const daemons: LocalDaemon[] = [];
afterEach(async () => { daemons.splice(0).forEach((daemon) => daemon.stop()); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const SIMPLE_SOURCE = `const meta = { name: "exec-api", description: "API 测试", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  const done = await agent("完成任务", { id: "w1", cli: "codex" });
  return { ok: true, node: done.nodeId };
}`;

const GATE_SOURCE = `const meta = { name: "exec-api-gate", description: "带决策门", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  const answer = await decisionGate({ id: "confirm", question: "是否继续？" });
  if (!answer.ok) throw new Error("用户拒绝");
  return agent("继续任务", { id: "w2", cli: "codex" });
}`;

async function fixture(): Promise<{ baseUrl: string; harnessRunId: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-exec-api-"));
  directories.push(root);
  const previousHome = process.env.WAVE_FLOW_HOME;
  process.env.WAVE_FLOW_HOME = root;
  try {
    const daemon = new LocalDaemon({ deterministicForTest: true, storeRoot: runsRoot(root), harnessRoot: join(root, "harness-runs") });
    daemons.push(daemon);
    const server = daemon.start();
    const baseUrl = server.baseUrl;
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const configured = await post("/harness-config", { model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "test-key" });
    expect(configured.status).toBe(200);
    const project = await post("/projects", { cwd: root });
    expect(project.status).toBe(200);
    const { project: createdProject } = await project.json() as { project: { projectId: string } };
    const created = await post("/harness-runs", { projectId: createdProject.projectId });
    expect(created.status).toBe(200);
    const { harness } = await created.json() as { harness: { harnessRunId: string } };
    return { baseUrl, harnessRunId: harness.harnessRunId };
  } finally {
    if (previousHome === undefined) delete process.env.WAVE_FLOW_HOME; else process.env.WAVE_FLOW_HOME = previousHome;
  }
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待条件超时。 ");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Harness Execution daemon API", () => {
  test("草稿拒绝执行；接受后经 API 创建并完成 Execution", async () => {
    const { baseUrl, harnessRunId } = await fixture();
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions`, { source: SIMPLE_SOURCE });
    const draft = await post(baseUrl, `/harness-runs/${harnessRunId}/executions`, { revision: 1 });
    expect(draft.status).toBe(400);
    expect(((await draft.json()) as { error: string }).error).toContain("草稿永远不能执行");

    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions/1/accept`, {});
    const created = await post(baseUrl, `/harness-runs/${harnessRunId}/executions`, { revision: 1, input: {} });
    expect(created.status).toBe(200);
    const { execution, snapshot } = await created.json() as { execution: { executionId: string; revision: number; status: string }; snapshot: { status: string } };
    expect(execution).toMatchObject({ revision: 1, status: "running" });
    expect(snapshot.status).toBe("running");

    await waitFor(async () => {
      const list = await fetch(`${baseUrl}/harness-runs/${harnessRunId}/executions`).then((value) => value.json()) as { executions: Array<{ status: string }> };
      return list.executions[0]?.status === "completed";
    });
    const detail = await fetch(`${baseUrl}/harness-runs/${harnessRunId}/executions/${execution.executionId}`).then((value) => value.json()) as { execution: { summary: unknown }; snapshot: { status: string; phases: Array<{ agents: Array<{ id: string; status: string }> }> } };
    expect(detail.execution.summary).toEqual({ ok: true, node: "w1" });
    expect(detail.snapshot.phases[0].agents[0]).toMatchObject({ id: "w1", status: "completed" });
    // Execution 不进入用户级 Run 列表。
    expect(await fetch(`${baseUrl}/api/runs`).then((value) => value.json())).toEqual([]);
  });

  test("决策门 API：等待、答题校验与完成后唤醒", async () => {
    const { baseUrl, harnessRunId } = await fixture();
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions`, { source: GATE_SOURCE });
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions/1/accept`, {});
    const created = await post(baseUrl, `/harness-runs/${harnessRunId}/executions`, { revision: 1 });
    const { execution } = await created.json() as { execution: { executionId: string } };
    await waitFor(async () => {
      const detail = await fetch(`${baseUrl}/harness-runs/${harnessRunId}/executions/${execution.executionId}`).then((value) => value.json()) as { snapshot: { gates: unknown[] } };
      return detail.snapshot.gates.length === 1;
    });
    const badAnswer = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/gates/confirm/answer`, { answer: "不是对象" });
    expect(badAnswer.status).toBe(400);
    const answered = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/gates/confirm/answer`, { answer: { ok: true } });
    expect(answered.status).toBe(200);
    await waitFor(async () => {
      const list = await fetch(`${baseUrl}/harness-runs/${harnessRunId}/executions`).then((value) => value.json()) as { executions: Array<{ status: string }> };
      return list.executions[0]?.status === "completed";
    });
    const duplicate = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/gates/confirm/answer`, { answer: { ok: true } });
    expect(duplicate.status).toBe(409);
  });

  test("stop 与 resume 授权边界", async () => {
    const { baseUrl, harnessRunId } = await fixture();
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions`, { source: GATE_SOURCE });
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions/1/accept`, {});
    const created = await post(baseUrl, `/harness-runs/${harnessRunId}/executions`, { revision: 1 });
    const { execution } = await created.json() as { execution: { executionId: string } };
    await waitFor(async () => {
      const detail = await fetch(`${baseUrl}/harness-runs/${harnessRunId}/executions/${execution.executionId}`).then((value) => value.json()) as { snapshot: { gates: unknown[] } };
      return detail.snapshot.gates.length === 1;
    });
    const unauthorized = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/resume`, {});
    expect(unauthorized.status).toBe(400);
    const duplicateResume = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/resume`, { authorized: true });
    expect(duplicateResume.status).toBe(409);
    const stopped = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { snapshot: { status: string } }).snapshot.status).toBe("cancelled");
    const pauseAfterStop = await post(baseUrl, `/harness-runs/${harnessRunId}/executions/${execution.executionId}/pause`, {});
    expect(pauseAfterStop.status).toBe(409);
  });

  test("Execution SSE 推送快照并在终态关闭", async () => {
    const { baseUrl, harnessRunId } = await fixture();
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions`, { source: SIMPLE_SOURCE });
    await post(baseUrl, `/harness-runs/${harnessRunId}/workflow-revisions/1/accept`, {});
    const created = await post(baseUrl, `/harness-runs/${harnessRunId}/executions`, { revision: 1 });
    const { execution } = await created.json() as { execution: { executionId: string } };
    const response = await fetch(`${baseUrl}/harness-runs/${harnessRunId}/executions/${execution.executionId}/events`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"status":"completed"');
  });
});
