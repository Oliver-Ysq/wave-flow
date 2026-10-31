import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RunRuntime } from "../../src/runtime/run-runtime";
import type { ControlServer } from "../../src/control/control-server";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { ExecutionConfigSnapshot, WorkerAssignment } from "../../src/lead/types";
import type { RuntimeProvenance } from "../../src/runtimes/types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";
import { readSkillLibraryDigest } from "../../src/skills/library";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const twoNodes: WorkflowModule<JsonObject, unknown> = {
  meta: { name: "skills-replay", description: "技能库回放判定。", phases: [{ title: "run" }] },
  default: async () => { phase("run"); const a = await agent("first", { id: "a", cli: "codex" }); const b = await agent("second", { id: "b", cli: "codex" }); return { a, b }; },
};

function testConfig(): ExecutionConfigSnapshot {
  const assignment = (agentId: string): WorkerAssignment => ({ agentId, cli: "codex", model: "cli-default", source: "lead-cli", runtimeId: "runtime-codex", adapterId: "codex-acp", adapterVersion: "2.2.2" });
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: "runtime-codex", ruleText: null, ruleDegraded: false, defaultAssignment: assignment("*"), assignments: [assignment("a"), assignment("b")] };
}

function provenance(skillsDigest: string | null): RuntimeProvenance {
  return {
    runtimeId: "runtime-codex", cli: "codex", executablePath: "/usr/local/bin/codex", version: "codex-cli 0.159.2", adapterId: "codex-acp", adapterVersion: "2.2.2", verifiedAt: new Date().toISOString(),
    ...(skillsDigest ? { skills: { digest: skillsDigest, mechanism: "codex-extra-roots" as const, count: 1, names: ["alpha"] } } : {}),
  };
}

async function library(root: string, body: string): Promise<string> {
  const skills = join(root, "skills"); await mkdir(join(skills, "alpha"), { recursive: true });
  await writeFile(join(skills, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: A\n---\n\n${body}\n`, "utf8");
  return skills;
}

/** 初始执行：a 记录 skills provenance 并 complete；b 失败使 Run interrupted。 */
function initialExecutor(skillsDigest: string, controlRef: { current: ControlServer | null }): AgentNodeExecutor {
  return {
    execute: async (node) => {
      if (node.id === "b") return null;
      const control = controlRef.current!;
      const capability = crypto.randomUUID();
      control.register({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability });
      await control.recordSession({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "s", capabilities: {}, runtime: provenance(skillsDigest) } });
      await control.complete({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability, summary: "完成", result: { ok: node.id } });
      return { ok: node.id };
    },
  };
}

async function interruptedRun(skillsDigest: string): Promise<RunRuntime> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-skill-replay-")); directories.push(cwd);
  const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow", "utf8");
  const controlRef: { current: ControlServer | null } = { current: null };
  const runtime = await RunRuntime.create({ workflow: twoNodes, input: {}, workflowSource: "workflow", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor: initialExecutor(skillsDigest, controlRef), executionConfig: testConfig() });
  controlRef.current = runtime.createControlServer();
  await runtime.run(twoNodes).catch(() => undefined);
  expect(runtime.snapshot().status).toBe("interrupted");
  return runtime;
}

describe("技能库参与 Replay 判定", () => {
  test("库摘要变化时已 completed 节点不复用，从该节点起重跑", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-skill-replay-dirs-")); directories.push(root);
    const oldDigest = (await readSkillLibraryDigest(await library(join(root, "old"), "old body")))!;
    const initial = await interruptedRun(oldDigest);
    const changed = await library(join(root, "changed"), "changed body");
    expect(await readSkillLibraryDigest(changed)).not.toBe(oldDigest);
    const executed: string[] = [];
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async node => { executed.push(node.id); return { ok: node.id }; } }, join(initial.journal.directory, ".."), testConfig(), changed);
    await resumed.run(twoNodes);
    expect(executed).toEqual(["a", "b"]);
    const { events } = await RunJournal.open(initial.snapshot().id, join(initial.journal.directory, ".."));
    expect(events.filter(event => event.type === "agent.restarted").map(event => [event.nodeId, event.invalidatedByPriorRestart])).toEqual([["a", true], ["b", true]]);
  });

  test("库摘要一致时复用 completed 前缀，只重跑失败节点", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-skill-replay-same-")); directories.push(root);
    const skills = await library(join(root, "same"), "same body");
    const digest = (await readSkillLibraryDigest(skills))!;
    const initial = await interruptedRun(digest);
    const executed: string[] = [];
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async node => { executed.push(node.id); return { ok: node.id }; } }, join(initial.journal.directory, ".."), testConfig(), skills);
    await resumed.run(twoNodes);
    expect(executed).toEqual(["b"]);
  });
});
