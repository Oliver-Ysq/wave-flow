import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import { managedAcpTransport } from "../../src/workspace/managed-acp-transport";
import { WriterProcessGroups } from "../../src/workspace/writer-process-group";
import type { AcpLauncher, AcpTransport } from "../../src/adapters/acp-session";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function boundary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-acp-boundary-test-"))); paths.push(root);
  const workspace = join(root, "workspace"), scratch = join(root, "scratch"), main = join(root, "main");
  for (const path of [workspace, scratch, main]) await mkdir(path);
  return { workspace, scratch, controlFiles: [], protectedDirectories: [main] };
}
test.skipIf(process.platform !== "darwin")("受管transport先绑定writer再交付ACP stream，close不等于退出核验", async () => {
  const value = await boundary(); let launched: AcpLauncher | null = null, bound = "", closed = 0, alive = true, exit!: () => void;
  const groups = new WriterProcessGroups(() => alive);
  const stream = acp.ndJsonStream(new WritableStream<Uint8Array>({ write() {} }), new ReadableStream<Uint8Array>({ start() {} }));
  const exited = new Promise<number>(resolve => { exit = () => resolve(0); });
  const factory = managedAcpTransport({ boundary: value, groups, bindWriter: async identity => { bound = identity; }, transport: async launcher => { launched = launcher; return { stream, exited, close() { closed++; }, writerProcess: { pid: 43210, exited, terminate() { closed++; alive = false; exit(); } } }; } });
  const transport = await factory({ id: "codex-acp", command: "/bin/true", args: ["arg"], env: { CODEX_PATH: "/bin/true" } }, new AbortController().signal);
  expect(bound).not.toBe(""); expect((launched as unknown as AcpLauncher).command).toBe("/usr/bin/sandbox-exec"); expect((launched as unknown as AcpLauncher).env?.TMPDIR).toBe(value.scratch);
  transport.close(); expect(closed).toBe(1); expect(groups.hasExited(bound)).toBe(false);
  await transport.verifyClosed!(); expect(groups.hasExited(bound)).toBe(true);
});
test.skipIf(process.platform !== "darwin")("无真实writer句柄或绑定落盘失败时关闭transport，不交付可运行ACP连接", async () => {
  const value = await boundary(), groups = new WriterProcessGroups(() => false); let closed = 0;
  const stream = acp.ndJsonStream(new WritableStream<Uint8Array>(), new ReadableStream<Uint8Array>());
  const base: AcpTransport = { stream, exited: Promise.resolve(0), close() { closed++; } };
  const missing = managedAcpTransport({ boundary: value, groups, bindWriter: async () => {}, transport: async () => base });
  await expect(missing({ id: "test", command: "/bin/true", args: [] }, new AbortController().signal)).rejects.toThrow("真实进程组");
  const failing = managedAcpTransport({ boundary: value, groups, bindWriter: async () => { throw new Error("绑定失败"); }, transport: async () => ({ ...base, writerProcess: { pid: 43210, exited: Promise.resolve(0), terminate() {} } }) });
  await expect(failing({ id: "test", command: "/bin/true", args: [] }, new AbortController().signal)).rejects.toThrow("绑定失败");
  expect(closed).toBe(2);
});
