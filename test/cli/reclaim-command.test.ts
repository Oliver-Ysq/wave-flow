import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeBlock } from "../../src/cli/block-command";
import { executeComplete } from "../../src/cli/complete-command";
import { executeAnswer, executeContinue } from "../../src/cli/hitl-command";
import { discoverDaemon } from "../../src/daemon/daemon-lifecycle";
import { daemonUserIdentity, publishDescriptor } from "../../src/daemon/daemon-descriptor";
import { LocalDaemon } from "../../src/daemon/local-daemon";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import type { JournalEvent } from "../../src/journal/types";
import { RealCodexExecutor } from "../../src/runtime/real-codex-executor";
import type { DestroyResult, SessionBackend, SessionIdentity } from "../../src/sessions/types";

const directories: string[] = [];
const daemons: LocalDaemon[] = [];
afterEach(async () => {
  daemons.splice(0).forEach((daemon) => daemon.stop());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent CLI reclaim commands", () => {
  test("block 重连、continue 与真实 daemon 发现形成跨重启闭环", async () => {
    const setup = await startManagedRun();
    const discoveryRoot = await mkdtemp(join(tmpdir(), "wave-flow-cli-discovery-"));
    directories.push(discoveryRoot);
    await publish(portOf(setup.firstServer.baseUrl), setup.first.instanceId, discoveryRoot);
    const discover = () => discoverDaemon(discoveryRoot, async () => TEST_PROCESS_IDENTITY);

    const block = executeBlock({ needHelp: "需要人工确认", identity: setup.identity }, discover);
    await waitForSnapshot(setup.firstServer.baseUrl, setup.identity.runId, "blocked");
    setup.first.stop();

    const second = new LocalDaemon({ storeRoot: setup.storeRoot, verifyReclaimSession: async () => true });
    daemons.push(second);
    const secondServer = second.start();
    await publish(portOf(secondServer.baseUrl), second.instanceId, discoveryRoot);

    const opened = await RunJournal.open(setup.identity.runId, setup.storeRoot);
    const blockRequest = opened.events.find((event): event is Extract<JournalEvent, { type: "block.created" }> => event.type === "block.created");
    if (!blockRequest) throw new Error("测试 block.created 未落盘。");
    await executeAnswer({ blockRequestId: blockRequest.blockRequestId, answer: { approved: true } }, secondServer.baseUrl);
    await expect(block).resolves.toEqual({ blockRequestId: blockRequest.blockRequestId, answer: { approved: true } });

    await executeContinue({ blockRequestId: blockRequest.blockRequestId, identity: setup.identity }, discover);
    await expect(fetch(`${secondServer.baseUrl}/runs/${setup.identity.runId}`).then((response) => response.json())).resolves.toMatchObject({
      snapshot: { phases: [{ agents: [{ status: "running" }] }] },
    });
    expect(setup.launches()).toBe(1);
  });

  test("complete 经真实发现与 reclaim 路由写入结果、校验和 Journal", async () => {
    const setup = await startManagedRun();
    const discoveryRoot = await mkdtemp(join(tmpdir(), "wave-flow-cli-discovery-"));
    directories.push(discoveryRoot);
    setup.first.stop();
    const second = new LocalDaemon({ storeRoot: setup.storeRoot, verifyReclaimSession: async () => true });
    daemons.push(second);
    const secondServer = second.start();
    await publish(portOf(secondServer.baseUrl), second.instanceId, discoveryRoot);
    const resultDirectory = await mkdtemp(join(tmpdir(), "wave-flow-cli-result-"));
    directories.push(resultDirectory);
    const resultFile = join(resultDirectory, "result.json");
    await writeFile(resultFile, '{"ok":true}', "utf8");

    await executeComplete({ summary: "CLI reclaimed", resultFile, identity: setup.identity }, () => discoverDaemon(discoveryRoot, async () => TEST_PROCESS_IDENTITY));

    const opened = await RunJournal.open(setup.identity.runId, setup.storeRoot);
    const completed = opened.events.find((event): event is Extract<JournalEvent, { type: "agent.completed" }> => event.type === "agent.completed");
    expect(completed).toMatchObject({ nodeId: setup.identity.nodeId, agentSessionId: setup.identity.agentSessionId, result: { ok: true } });
    expect(completed?.resultPath).toContain(`/attempts/`);
    expect(completed?.validationPath).toContain(`/attempts/`);
    expect(setup.launches()).toBe(1);
  });
});

async function startManagedRun(): Promise<{ readonly first: LocalDaemon; readonly firstServer: { readonly baseUrl: string }; readonly storeRoot: string; readonly identity: { readonly runId: string; readonly nodeId: string; readonly agentSessionId: string }; readonly launches: () => number }> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-cli-workflow-"));
  directories.push(cwd);
  const store = await mkdtemp(join(tmpdir(), "wave-flow-cli-store-"));
  directories.push(store);
  const workflowPath = join(cwd, "workflow.ts");
  await writeFile(workflowPath, `import { agent, phase } from "wave-flow";
export const meta = { name: "cli-reclaim", description: "Check CLI reclaim.", phases: [{ title: "run" }] };
export default async function run(_args: {}) { phase("run"); return agent("Review", { id: "review", cli: "codex" }); }`, "utf8");
  let options: import("../../src/sessions/types").CreateSessionOptions | null = null;
  let launches = 0;
  const backend: SessionBackend = {
    async create(value) { options = value; return identity(value.runId, value.nodeId, value.agentSessionId!, value.reclaimTokenHash); },
    async sendText() {}, async pasteText() {}, async sendSpecialKey() {}, async readRecent() { return ""; }, async liveness() { return "exists"; }, async detach() {},
    async destroy(): Promise<DestroyResult> { return { status: "destroyed", diagnostic: null }; },
  };
  const storeRoot = runsRoot(store);
  const first = new LocalDaemon({
    storeRoot,
    createRealExecutor: ({ controlUrl, runsRoot: root }) => new RealCodexExecutor(
      backend, controlUrl, root,
      async (_sessions, adapter, request) => {
        launches += 1;
        const plan = await adapter.launch(request, new AbortController().signal);
        return { identity: await backend.create({ runId: request.runId, nodeId: request.node.id, agentSessionId: request.node.agentSessionId!, cli: "codex", cwd: request.node.cwd, command: plan.command, env: plan.env, identityFile: request.identityFile, reclaimTokenHash: request.reclaimTokenHash }) };
      },
      1_000,
      false,
    ),
  });
  daemons.push(first);
  const firstServer = first.start();
  const createResponse = await fetch(`${firstServer.baseUrl}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: crypto.randomUUID(), workflowPath, cwd, input: {} }) });
  if (!createResponse.ok) throw new Error(`创建受管 Run 失败：${await createResponse.text()}`);
  const created = await createResponse.json() as { runId: string };
  await waitFor(() => options !== null);
  const env = options!.env!;
  return { first, firstServer, storeRoot, identity: { runId: created.runId, nodeId: env.WF_NODE_ID!, agentSessionId: env.WF_AGENT_SESSION_ID! }, launches: () => launches };
}

async function publish(port: number, bootInstanceId: string, root: string): Promise<void> {
  await publishDescriptor({ protocolVersion: 2, userIdentity: daemonUserIdentity(), bootInstanceId, port, pid: process.pid, processStartIdentity: TEST_PROCESS_IDENTITY, heartbeatAt: new Date().toISOString() }, root);
}

const TEST_PROCESS_IDENTITY = "test-process-start-identity";

function portOf(baseUrl: string): number {
  const port = Number(new URL(baseUrl).port);
  if (!Number.isSafeInteger(port) || port < 1) throw new Error("测试 daemon 未返回有效端口。");
  return port;
}

function identity(runId: string, nodeId: string, agentSessionId: string, reclaimTokenHash?: string): SessionIdentity {
  return { backend: "tmux", sessionName: "wf-cli-test", backendRef: "/tmp/wf-cli-test.sock", runId, nodeId, agentSessionId, cli: "codex", createdAt: new Date().toISOString(), ...(reclaimTokenHash ? { reclaimTokenHash } : {}) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("等待 Agent 会话启动超时。"); await Bun.sleep(2); }
}

async function waitForSnapshot(baseUrl: string, runId: string, status: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fetch(`${baseUrl}/runs/${runId}`).then((response) => response.json()) as { snapshot?: { phases?: Array<{ agents?: Array<{ status?: string }> }> } };
    if (value.snapshot?.phases?.[0]?.agents?.[0]?.status === status) return;
    if (Date.now() >= deadline) throw new Error(`等待节点进入 ${status} 超时。`);
    await Bun.sleep(2);
  }
}
