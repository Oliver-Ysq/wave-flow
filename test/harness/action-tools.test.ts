import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessActionTools, HARNESS_ACTION_TOOL_NAMES, type HarnessActionCallbacks } from "../../src/harness/action-tools";
import { isHarnessToolAllowed, type HarnessPiSession } from "../../src/harness/pi-harness";
import { HarnessService } from "../../src/harness/service";
import type { HarnessStreamEvent } from "../../src/harness/types";
import { HarnessJournal } from "../../src/harness/journal";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const model = { model: "test", baseUrl: "https://example.test/v1", apiKey: "test-key" };

class DecisionPi implements HarnessPiSession {
  #listeners = new Set<(event: HarnessStreamEvent) => void>();
  isRunning = false;
  constructor(private readonly actions: HarnessActionCallbacks) {}
  subscribe(listener: (event: HarnessStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prompt(_text: string): Promise<string> {
    this.isRunning = true;
    const answer = await this.actions.requestUserDecision("请选择执行策略", { type: "object", required: ["choice"], properties: { choice: { type: "string" } } });
    this.isRunning = false;
    return `用户选择：${answer.choice}`;
  }
  abort() { this.isRunning = false; }
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("等待条件超时。 ");
    await Bun.sleep(2);
  }
}

describe("Harness action tools", () => {
  test("只注册四个行动窄工具，既没有 complete 也没有节点创建工具", () => {
    const actions: HarnessActionCallbacks = {
      proposeWorkflowRevision: async () => ({ revision: 1, sourceHash: "a".repeat(64) }),
      inspectExecution: async () => [], readRunCapsule: async () => ({}), requestUserDecision: async () => ({ ok: true }),
    };
    const tools = createHarnessActionTools(actions);
    expect(tools.map((tool) => tool.name)).toEqual([...HARNESS_ACTION_TOOL_NAMES]);
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["complete", "create_node", "run_workflow"]));
  });

  test("beforeToolCall 白名单只允许已注册工具", () => {
    expect(isHarnessToolAllowed("read_project_file", false)).toBe(true);
    expect(isHarnessToolAllowed("propose_workflow_revision", true)).toBe(true);
    expect(isHarnessToolAllowed("propose_workflow_revision", false)).toBe(false);
    expect(isHarnessToolAllowed("complete", true)).toBe(false);
    expect(isHarnessToolAllowed("create_node", true)).toBe(false);
  });

  test("主控回合等待决策时，独立答题路径可耐久并唤醒回合", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-actions-"));
    directories.push(cwd);
    let captured: HarnessActionCallbacks | null = null;
    const service = new HarnessService(cwd, async () => model, (_config, _cwd, _prior, actions) => {
      captured = actions;
      return new DecisionPi(actions);
    });
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "需要用户选择");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).decisions.length === 1);
    expect(captured).not.toBeNull();
    const [decision] = (await service.snapshot(created.harnessRunId)).decisions;
    const before=(await HarnessJournal.open(created.harnessRunId,cwd)).events.length;
    await expect(service.answerUserDecision(created.harnessRunId,decision.decisionId,{choice:42})).rejects.toThrow("answerSchema");
    expect((await HarnessJournal.open(created.harnessRunId,cwd)).events.length).toBe(before);
    const answers=await Promise.allSettled([service.answerUserDecision(created.harnessRunId,decision.decisionId,{choice:"安全模式"}),service.answerUserDecision(created.harnessRunId,decision.decisionId,{choice:"重复"})]);
    expect(answers.filter(answer=>answer.status==="fulfilled")).toHaveLength(1);
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "idle");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({
      messages: [{ role: "user" }, { role: "assistant", text: "用户选择：安全模式" }],
    });
  });

  test("停止等待用户决策的主控回合会释放 waiter 并收敛为 interrupted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-harness-actions-abort-"));
    directories.push(cwd);
    const service = new HarnessService(cwd, async () => model, (_config, _cwd, _prior, actions) => new DecisionPi(actions));
    const created = await service.create(cwd);
    await service.send(created.harnessRunId, "需要决定");
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).decisions.length === 1);
    await service.abort(created.harnessRunId);
    await waitFor(async () => (await service.snapshot(created.harnessRunId)).status === "interrupted");
    await expect(service.snapshot(created.harnessRunId)).resolves.toMatchObject({ diagnostic: "用户已停止 Harness 主控回合。 " });
    const decision=(await service.snapshot(created.harnessRunId)).decisions[0];
    await expect(service.answerUserDecision(created.harnessRunId,decision.decisionId,{choice:"迟到"})).rejects.toThrow("失效");
  });
});
