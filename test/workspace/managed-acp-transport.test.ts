import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import { managedAcpTransport, ownedAcpTransport } from "../../src/workspace/managed-acp-transport";
import { WriterProcessGroups } from "../../src/workspace/writer-process-group";
import type { AcpLauncher, AcpTransport } from "../../src/adapters/acp-session";

const paths: string[] = [];
test("可信Worker保留原生launcher及HOME，但投递前必须绑定真实进程证明",async()=>{
 const groups=new WriterProcessGroups(()=>false);let launched:AcpLauncher|null=null,bound="";
 const stream=acp.ndJsonStream(new WritableStream<Uint8Array>(),new ReadableStream<Uint8Array>());
 const launcher={id:"test",command:"/bin/true",args:["native"],env:{HOME:"/native/home",CODEX_HOME:"/native/home/.codex"}};
 const factory=ownedAcpTransport({groups,bindWriter:async identity=>{bound=identity;},transport:async value=>{launched=value;return {stream,exited:Promise.resolve(0),close(){},writerProcess:{pid:43210,exited:Promise.resolve(0),terminate(){}}};}});
 const transport=await factory(launcher,new AbortController().signal);expect(launched as AcpLauncher|null).toEqual(launcher);expect(bound).not.toBe("");await transport.verifyClosed!();expect(groups.hasExited(bound)).toBe(true);
});
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function boundary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-acp-boundary-test-"))); paths.push(root);
  const workspace = join(root, "workspace"), scratch = join(root, "scratch"), main = join(root, "main");
  for (const path of [workspace, scratch, main]) await mkdir(path);
  return { workspace: null, scratch, controlFiles: [], protectedDirectories: [main] };
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
test.skipIf(process.platform !== "darwin")("感知模式保留用户git环境，隔离模式继续禁用全局git配置", async () => {
  const value = await boundary();
  const seen: AcpLauncher[] = [];
  const stream = acp.ndJsonStream(new WritableStream<Uint8Array>(), new ReadableStream<Uint8Array>());
  const launch = (mode: "isolated" | "perception") => managedAcpTransport({
    boundary: { ...value, mode },
    groups: new WriterProcessGroups(() => false),
    bindWriter: async () => {},
    transport: async launcher => { seen.push(launcher); return { stream, exited: Promise.resolve(0), close() {}, writerProcess: { pid: 43211, exited: Promise.resolve(0), terminate() {} } }; },
  });
  await launch("perception")({ id: "test", command: "/bin/true", args: [], env: { HOME: "/native/home" } }, new AbortController().signal);
  await launch("isolated")({ id: "test", command: "/bin/true", args: [], env: { HOME: "/native/home" } }, new AbortController().signal);
  // 感知模式让用户原生 CLI 看到自己的 git 配置；隔离模式仍用空全局配置限制黑盒 CLI。
  expect(seen[0]?.env).toMatchObject({ HOME: "/native/home", TMPDIR: value.scratch });
  expect(seen[0]?.env?.GIT_CONFIG_GLOBAL).toBeUndefined();
  expect(seen[0]?.env?.GIT_CONFIG_NOSYSTEM).toBeUndefined();
  expect(seen[1]?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(seen[1]?.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
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
