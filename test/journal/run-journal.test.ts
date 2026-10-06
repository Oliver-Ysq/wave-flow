import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "../../src/journal/run-journal";
import { runsRoot } from "../../src/journal/paths";
import { RUNTIME_VERSION, type RunManifest } from "../../src/journal/types";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function manifest(cwd: string): RunManifest {
  return { runId: "11111111-1111-4111-8111-111111111111", clientRequestId: "22222222-2222-4222-8222-222222222222", runtimeVersion: RUNTIME_VERSION, workflow: { name: "journal-check", description: "Check journal.", phases: [{ title: "scan" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: "2026-10-02T00:00:00.000Z" };
}

describe("RunJournal", () => {
  test("以稳定诊断拒绝不存在的 Run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    await expect(RunJournal.open("11111111-1111-4111-8111-111111111111", runsRoot(cwd))).rejects.toThrow("指定 Run 不存在或 manifest 不可读取");
  });

  test("兼容读取 v3 Manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const old = { ...manifest(cwd), runtimeVersion: 3 as const };
    await RunJournal.create(old, runsRoot(cwd));
    await expect(RunJournal.open(old.runId, runsRoot(cwd))).resolves.toBeDefined();
  });

  test("兼容读取 v4 Manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const old = { ...manifest(cwd), runtimeVersion: 4 as const };
    await RunJournal.create(old, runsRoot(cwd));
    await expect(RunJournal.open(old.runId, runsRoot(cwd))).resolves.toBeDefined();
  });

  test("耐久创建 Manifest、事件和 JSON 对象结果", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    const path = await journal.writeResult("scan/auth", { ok: true });
    expect(JSON.parse(await readFile(join(journal.directory, path), "utf8"))).toEqual({ nodeId: "scan/auth", result: { ok: true } });
    const opened = await RunJournal.open(journal.manifest.runId, runsRoot(cwd));
    expect(opened.events).toHaveLength(1);
  });

  test("不同 Agent attempt 的结果与校验记录不得互相覆盖", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    const first = await journal.writeResult("scan-auth", { attempt: 1 }, "session-one");
    const second = await journal.writeResult("scan-auth", { attempt: 2 }, "session-two");
    const firstValidation = await journal.writeValidation("scan-auth", {}, { attempt: 1 }, "session-one");
    const secondValidation = await journal.writeValidation("scan-auth", {}, { attempt: 2 }, "session-two");
    expect(first).not.toBe(second);
    expect(firstValidation).not.toBe(secondValidation);
    await expect(Bun.file(join(journal.directory, first)).json()).resolves.toEqual({ nodeId: "scan-auth", result: { attempt: 1 } });
    await expect(Bun.file(join(journal.directory, second)).json()).resolves.toEqual({ nodeId: "scan-auth", result: { attempt: 2 } });
  });

  test("拒绝软链接或宽权限的 Run Store 根目录", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const target = await mkdtemp(join(tmpdir(), "wave-flow-journal-target-")); directories.push(target);
    const linked = join(cwd, "linked-runs");
    await symlink(target, linked);
    await expect(RunJournal.create(manifest(cwd), linked)).rejects.toThrow("真实目录");
    const wide = join(cwd, "wide-runs");
    await writeFile(wide, "not-a-dir");
    await rm(wide);
    await Bun.$`mkdir -p ${wide}`;
    await chmod(wide, 0o755);
    await expect(RunJournal.create(manifest(cwd), wide)).rejects.toThrow("权限过宽");
  });

  test("重开 completed 节点时要求独立结果文件存在且与事件一致", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd, prompt: "scan", phase: "scan" };
    await journal.append({ type: "agent.created", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request });
    await journal.append({ type: "agent.status", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, status: "running" });
    const resultPath = await journal.writeResult("scan-auth", { ok: true });
    await journal.append({ type: "agent.completed", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, resultPath, result: { ok: true } });
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).resolves.toMatchObject({ events: expect.any(Array) });
    await writeFile(join(journal.directory, resultPath), JSON.stringify({ nodeId: "scan-auth", result: { ok: false } }), "utf8");
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("结果文件与 Journal 事件不一致");
  });

  test("允许唯一截断尾行，但拒绝中间损坏", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    await appendFile(join(journal.directory, "journal.jsonl"), "{\"type\":", "utf8");
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).resolves.toMatchObject({ events: [{ type: "run.created" }] });
    await appendFile(join(journal.directory, "journal.jsonl"), "\nnot-json\n{}\n", "utf8");
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("第 2 行损坏");
  });

  test("并发追加保持一行一个完整 JSON 事实", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    await Promise.all(Array.from({ length: 20 }, (_, index) => journal.append({
      type: "log.written", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, message: `log-${index}`,
    })));
    const text = await readFile(join(journal.directory, "journal.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(21);
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).resolves.toMatchObject({ events: expect.any(Array) });
  });

  test("拒绝未知事件与不合法状态顺序", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    await appendFile(join(journal.directory, "journal.jsonl"), `${JSON.stringify({ type: "unknown", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null })}\n`, "utf8");
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("未知");
  });

  test("拒绝完成节点早于创建节点的事件顺序", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    await appendFile(join(journal.directory, "journal.jsonl"), `${JSON.stringify({ type: "agent.completed", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "missing", agentSessionId: null, diagnostic: null, resultPath: "nodes/x/result.json", result: { ok: true } })}\n`, "utf8");
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("未知 Agent 节点");
  });

  test("完整的非 JSON 尾行不能伪装为截断写入", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    await appendFile(join(journal.directory, "journal.jsonl"), "not-json", "utf8");
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("第 2 行损坏");
  });

  test("Control completed 重开时必须有先前耐久的 agent.session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd, prompt: "scan", phase: "scan" };
    await journal.append({ type: "agent.created", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request });
    await journal.append({ type: "agent.status", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "session", diagnostic: null, status: "running" });
    const resultPath = await journal.writeResult("scan-auth", { ok: true });
    const validationPath = await journal.writeValidation("scan-auth", {}, { ok: true });
    await journal.append({ type: "agent.completed", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "session", diagnostic: "done", resultPath, validationPath, result: { ok: true } });
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("缺少先前的 agent.session");
  });

  test("App Server 坐标接受 URL 语义等价的无尾随斜杠 endpoint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd, prompt: "scan", phase: "scan" };
    const session = { backend: "tmux" as const, sessionName: "wf-test", backendRef: "/tmp/wf.sock", runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "session", cli: "codex" as const, createdAt: new Date().toISOString() };
    await journal.append({ type: "agent.created", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request });
    await journal.append({ type: "agent.status", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "session", diagnostic: null, status: "running" });
    await journal.append({ type: "agent.session", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "session", diagnostic: "codex-rpc", delivery: "codex-rpc", session, appServer: { endpoint: "ws://127.0.0.1:43180", threadId: "thread", turnId: "turn", protocolVersion: 1 } });
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).resolves.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ type: "agent.session" })]) });
  });

  test("重开时拒绝被篡改为不符合 answer-schema 的 block 答案", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-journal-")); directories.push(cwd);
    const journal = await RunJournal.create(manifest(cwd), runsRoot(cwd));
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd, prompt: "scan", phase: "scan" };
    const sessionId = "session";
    const blockRequestId = "33333333-3333-4333-8333-333333333333";
    await journal.append({ type: "agent.created", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request });
    await journal.append({ type: "agent.status", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: sessionId, diagnostic: null, status: "running" });
    await journal.append({ type: "block.created", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: sessionId, diagnostic: "需要确认", blockRequestId, needHelp: "需要确认", answerSchema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } } });
    await journal.append({ type: "block.answered", at: new Date().toISOString(), runId: journal.manifest.runId, nodeId: "scan-auth", agentSessionId: sessionId, diagnostic: null, blockRequestId, answer: { approved: "yes" } });
    await expect(RunJournal.open(journal.manifest.runId, runsRoot(cwd))).rejects.toThrow("answer-schema");
  });
});
