import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import { managedAcpTransport, verifiedAcpTransport } from "../../src/workspace/managed-acp-transport";
import type { AcpLauncher, AcpTransport } from "../../src/adapters/acp-session";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function boundary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-acp-boundary-test-"))); paths.push(root);
  const workspace = join(root, "workspace"), scratch = join(root, "scratch"), main = join(root, "main");
  for (const path of [workspace, scratch, main]) await mkdir(path);
  return { scratch, controlFiles: [], protectedDirectories: [main] };
}

test.skipIf(process.platform !== "darwin")("受管transport施加OS写边界，close不等于退出核验", async () => {
  const value = await boundary();
  let launched: AcpLauncher | null = null, closed = 0, terminated = 0, exit!: () => void;
  const stream = acp.ndJsonStream(new WritableStream<Uint8Array>({ write() {} }), new ReadableStream<Uint8Array>({ start() {} }));
  const exited = new Promise<number>(resolve => { exit = () => resolve(0); });
  const factory = managedAcpTransport({
    boundary: value,
    transport: async launcher => {
      launched = launcher;
      return { stream, exited, close() { closed += 1; }, writerProcess: { pid: 43210, exited, terminate() { terminated += 1; exit(); } } };
    },
  });
  const transport = await factory({ id: "codex-acp", command: "/bin/true", args: ["arg"], env: { CODEX_PATH: "/bin/true" } }, new AbortController().signal);
  expect((launched as unknown as AcpLauncher).command).toBe("/usr/bin/sandbox-exec");
  expect((launched as unknown as AcpLauncher).env?.TMPDIR).toBe(value.scratch);
  // close 只是关闭 ACP 连接；退出证明由 verifyClosed 单独核验。
  transport.close(); expect(closed).toBe(1); expect(terminated).toBe(0);
  await transport.verifyClosed!();
  expect(terminated).toBe(1);
});

test.skipIf(process.platform !== "darwin")("无真实writer句柄时关闭transport，不交付可运行ACP连接", async () => {
  const value = await boundary();
  let closed = 0;
  const stream = acp.ndJsonStream(new WritableStream<Uint8Array>(), new ReadableStream<Uint8Array>());
  const base: AcpTransport = { stream, exited: Promise.resolve(0), close() { closed += 1; } };
  const factory = managedAcpTransport({ boundary: value, transport: async () => base });
  await expect(factory({ id: "test", command: "/bin/true", args: [] }, new AbortController().signal)).rejects.toThrow("真实进程组");
  expect(closed).toBe(1);
});

test("只读/非受管 transport 保留原生命令并补退出核验，不套主控写沙箱", async () => {
  let launchedCommand = "", terminated = 0;
  const stream = acp.ndJsonStream(new WritableStream<Uint8Array>(), new ReadableStream<Uint8Array>());
  let exit!: () => void;
  const exited = new Promise<number>(resolve => { exit = () => resolve(0); });
  const factory = verifiedAcpTransport({
    transport: async launcher => {
      launchedCommand = launcher.command;
      return { stream, exited, close() {}, writerProcess: { pid: 43210, exited, terminate() { terminated += 1; exit(); } } };
    },
  });
  const transport = await factory({ id: "native", command: "/bin/true", args: ["arg"], env: {} }, new AbortController().signal);
  expect(launchedCommand).toBe("/bin/true");
  expect(transport.verifyClosed).toBeFunction();
  await transport.verifyClosed!();
  expect(terminated).toBe(1);
});

test("写 Worker 生产执行器不套主控写沙箱", async () => {
  const source = await Bun.file("src/workspace/production-workspace-executor.ts").text();
  expect(source).not.toContain("managedAcpTransport");
  expect(source).toContain("verifiedAcpTransport");
});
