import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { adapterById } from "../../src/runtimes/adapter-catalog";
import { resolveLeadLauncher } from "../../src/runtimes/worker-launcher-resolver";
import { createLeadSession } from "../../src/lead/lead-session";
import { prepareSessionScratch } from "../../src/workspace/session-scratch";
import { LeadService } from "../../src/lead/service";
import { LeadControlChannel } from "../../src/lead/lead-control-channel";
import { buildLeadSystemPrompt } from "../../src/lead/lead-prompt";
import { bunAcpTransport } from "../../src/adapters/acp-session";
import type * as acp from "@agentclientprotocol/sdk";

test.skipIf(process.env.WF_REAL_LEAD_MODEL_ACCEPTANCE !== "1")("真实主控原生跨目录读与窄工具调用，不创建执行或修改项目", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-lead-model-"))), cwd = join(root, "project"), state = join(root, "state");
  await mkdir(cwd); await mkdir(state, { mode: 0o700 });
  const inside = join(cwd, "marker.txt"), outside = join(root, "outside.txt");
  await writeFile(inside, "INSIDE_FIXTURE_42\n"); await writeFile(outside, "OUTSIDE_FIXTURE_73\n");
  const registry = new CliRuntimeRegistry(), cli = (process.env.WF_REAL_LEAD_CLI ?? "codex") as "codex" | "claude" | "dsh" | "kimi", runtime = await registry.resolveWorker(cli), entry = adapterById(runtime.verifiedAdapter.adapterId)!;
  const launcher = resolveLeadLauncher(runtime);
  const pipes: LeadControlChannel[] = [];
  const service = new LeadService(join(root, "lead-runs"), async (id, project, prior) => {
    const scratch = await prepareSessionScratch(join(root, "scratch"), project), pipe = new LeadControlChannel(request => service.mcpTools(id, request), scratch); pipes.push(pipe);
    const mcp = { name: "wave-flow-lead", command: process.execPath, args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__lead-mcp"], env: [{ name: "WF_LEAD_CONTROL_SOCKET", value: pipe.endpoints.socketPath }] } as acp.McpServer;
    const observe: import("../../src/adapters/acp-session").AcpTransportFactory | undefined = process.env.WF_REAL_LEAD_TRACE === "1" ? async (launcher, signal) => {
      const value = await bunAcpTransport(launcher, signal);
      const readable = value.stream.readable.pipeThrough(new TransformStream({ transform(message, controller) {
        // 只打印协议种类/会话身份，不打印正文、prompt、工具参数或凭据。
        const raw = message as unknown as { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string } }; id?: unknown; result?: { stopReason?: string }; error?: { code?: number; message?: string } };
        console.log(JSON.stringify({ method: raw.method, sessionId: raw.params?.sessionId, update: raw.params?.update?.sessionUpdate, responseId: raw.id, stopReason: raw.result?.stopReason, errorCode: raw.error?.code }));
        controller.enqueue(message);
      } }));
      return { ...value, stream: { ...value.stream, readable } };
    } : undefined;
    return createLeadSession({ launcher, cwd: project, scratch, prompt: buildLeadSystemPrompt(), prior, mcp, transport: observe, engineHome: join(root, "state"), skills: entry.skills ?? null, skillsRoot: join(root, "skills") });
  });
  try {
    const created = await service.create(cwd);
    console.log(JSON.stringify({ root, cli, task: created.leadRunId }));
    await service.send(created.leadRunId, `只做读取验收，不设计或执行Workflow。用当前CLI原生文件工具读取${inside}与${outside}，然后调用wave-flow-lead的inspect_execution读取执行列表。最后报告两个标记及执行数量；不得修改文件、安装依赖、创建Worker或提交草案。`);
    const deadline = Date.now() + 100_000;
    let snapshot = await service.snapshot(created.leadRunId);
    while (snapshot.status === "running" && Date.now() < deadline) { await Bun.sleep(100); snapshot = await service.snapshot(created.leadRunId); }
    console.log(JSON.stringify({ task: created.leadRunId, status: snapshot.status, diagnostic: snapshot.diagnostic }));
    expect(snapshot.status).toBe("idle"); const answer = snapshot.messages.at(-1)?.text ?? "";
    expect(answer).toContain("INSIDE_FIXTURE_42"); expect(answer).toContain("OUTSIDE_FIXTURE_73"); expect(snapshot.executions).toHaveLength(0); expect(snapshot.workflowRevisions).toHaveLength(0);
    expect(snapshot.conversationEntries.some(item => item.kind === "tool" && item.source === "engine-mcp" && item.name === "读取执行状态" && item.status === "completed")).toBe(true);
    expect(await Bun.file(inside).text()).toBe("INSIDE_FIXTURE_42\n"); expect(await Bun.file(outside).text()).toBe("OUTSIDE_FIXTURE_73\n");
  } finally { await service.close(); pipes.forEach(pipe => pipe.close()); }
}, 120_000);
