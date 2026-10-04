import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeComplete, parseCompleteCommand } from "../../src/cli/complete-command";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("complete command", () => {
  test("要求绝对结果路径与完整参数", () => {
    expect(parseCompleteCommand(["--summary", "done", "--result-file", "/tmp/result.json"])).toEqual({ summary: "done", resultFile: "/tmp/result.json" });
    expect(() => parseCompleteCommand(["--summary", "done", "--result-file", "result.json"])).toThrow("绝对路径");
    expect(() => parseCompleteCommand(["--summary", "done"])).toThrow("需要");
  });

  test("CLI 只上传本地已读取 JSON，不把 result-file 路径交给 daemon", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wave-flow-complete-")); directories.push(directory);
    const path = join(directory, "result.json"); await writeFile(path, '{"ok":true}', "utf8");
    const originalFetch = globalThis.fetch;
    let body: unknown;
    globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    try {
      await executeComplete({ summary: "done", resultFile: path }, { WF_CONTROL_URL: "http://127.0.0.1:1234", WF_RUN_ID: "run", WF_NODE_ID: "node", WF_AGENT_SESSION_ID: "session", WF_CONTROL_CAPABILITY: "cap" });
    } finally { globalThis.fetch = originalFetch; }
    expect(body).toEqual({ runId: "run", nodeId: "node", agentSessionId: "session", capability: "cap", summary: "done", result: { ok: true } });
    expect(JSON.stringify(body)).not.toContain(path);
  });
});
