import { expect, test } from "bun:test";
import { prepareIsolatedLauncher, type SessionIsolationProfile } from "../../src/runtimes/session-isolation";
import { adapterById } from "../../src/runtimes/adapter-catalog";

test("通用隔离入口支持任意已提供能力的Adapter，不按CLI名字分支", async () => {
  const calls: string[] = [];
  const profile: SessionIsolationProfile = {
    enabledRoles: ["harness"],
    prepare: async (launcher, scratch, role) => { calls.push(role); return { ...launcher, env: { PRIVATE_SESSION_ROOT: scratch } }; }, readOnlyPaths:()=>[],
  };
  const launcher = { id: "fixture-future-acp", command: "/fixture/agent", args: ["acp"] };
  expect(await prepareIsolatedLauncher(profile, launcher, "/fixture/scratch", "harness")).toEqual({ ...launcher, env: { PRIVATE_SESSION_ROOT: "/fixture/scratch" } });

  expect(calls).toEqual(["harness"]);
});

test("未声明能力或角色未启用时不调用prepare、不回退普通启动", async () => {
  let calls = 0;
  const launcher = { id: "fixture-other-acp", command: "/fixture/agent", args: [] };
  const profile: SessionIsolationProfile = { enabledRoles: ["harness"], prepare: async value => { calls++; return value; },readOnlyPaths:()=>[] };
  await expect(prepareIsolatedLauncher(undefined, launcher, "/fixture/scratch", "harness")).rejects.toThrow("拒绝普通启动回退");
  await expect(prepareIsolatedLauncher(profile, launcher, "/fixture/scratch", "worker" as never)).rejects.toThrow("worker");
  expect(calls).toBe(0);
});

test("当前Adapter隔离能力在Catalog声明，未知CLI未自动开放", async () => {
  expect(adapterById("codex-acp")?.sessionIsolation?.enabledRoles).toEqual(["harness"]);
  expect(adapterById("kimi-acp")?.sessionIsolation?.enabledRoles).toEqual(["harness"]);
  // claude/dsh 已完成主控隔离验收：声明 profile 与 harnessTools，未知 CLI 仍 fail closed。
  for (const id of ["claude-acp", "dsh-acp"] as const) {
    const entry = adapterById(id);
    expect(entry).not.toBeNull();
    expect(entry?.sessionIsolation?.enabledRoles).toEqual(["harness"]);
    expect(entry?.capabilities.harnessTools).toBe(true);
    // 私有 Home 的具体结构由 cli-session-home.test.ts 用夹具验证；此处只锁定 Catalog 声明。
    expect(typeof entry?.sessionIsolation?.prepare).toBe("function");
    expect(typeof entry?.sessionIsolation?.readOnlyPaths).toBe("function");
  }
  await expect(prepareIsolatedLauncher(undefined, { id: "unknown-acp", command: "/fixture/agent", args: [] }, "/fixture/scratch", "harness")).rejects.toThrow("拒绝普通启动回退");
  expect(adapterById("unknown-acp")).toBeNull();
});

test("当前Adapter开放各自原生目录，生成的主控配置仍受保护但凭据可原子刷新", ()=>{
  const codex=adapterById("codex-acp")!.sessionIsolation!,kimi=adapterById("kimi-acp")!.sessionIsolation!;
  // 仅验证准备后的launcher映射，绝不读取真实用户配置或登录。
  expect(codex.readOnlyPaths({id:"codex-acp",command:"x",args:[],env:{CODEX_HOME:"/x"}})).toEqual(["/x/config.toml","/x/plugins","/x/hooks","/x/skills","/x/AGENTS.md"]);
  expect(kimi.readOnlyPaths({id:"kimi-acp",command:"x",args:[],env:{KIMI_CODE_HOME:"/y"}})).toEqual(["/y/config.toml","/y/mcp.json","/y/plugins","/y/hooks","/y/skills","/y/AGENTS.md","/y/empty-skills"]);
  expect(codex.writableRoots!({id:"codex-acp",command:"x",args:[]})).toEqual([`${process.env.HOME}/.codex`]);
  expect(kimi.writableRoots!({id:"kimi-acp",command:"x",args:[]})).toEqual([`${process.env.HOME}/.kimi-code`]);
});

test("主控与Workspace核心不导入特定CLI的私有Home实现", async () => {
  for (const path of ["src/harness/isolated-harness.ts", "src/workspace/production-workspace-executor.ts"]) {
    const source = await Bun.file(path).text();
    expect(source).not.toContain("prepareCodexSessionHome");
    expect(source).not.toContain("prepareKimiSessionHome");
    expect(source).not.toContain('selected.cli !== "codex"');
    expect(source).not.toContain('launcher.id === "kimi-acp"');
    if(path.includes("isolated-harness"))expect(source).toContain("prepareIsolatedLauncher");
    else {expect(source).not.toContain("prepareIsolatedLauncher");expect(source).toContain("ownedAcpTransport");}
  }
});

test("生产主控和Worker统一allow原生ACP权限，仅主控文件隔离由OS承担", async () => {
  for (const path of ["src/harness/isolated-harness.ts", "src/runtime/runtime-acp-worker-executor.ts", "src/workspace/production-workspace-executor.ts", "src/runtime/acp-worker-executor.ts"]) {
    const source = await Bun.file(path).text();
    expect(source).toContain(', "allow"');
    expect(source).not.toContain('privateMcpPermission(');
  }
});

test("Worker明确说明信任边界，生产无宿主文件批准或执行通道", async () => {
 const prompt=await Bun.file("src/runtime/acp-worker-executor.ts").text();expect(prompt).toContain("Wave Flow不施加OS文件隔离");expect(prompt).not.toContain("其他工作区外写入一律拒绝");
 for(const path of ["src/workspace/production-workspace-executor.ts","src/desktop/desktop-execution-engine.ts","src/desktop/engine-main.ts"]){
  const source=await Bun.file(path).text();expect(source).not.toContain("FilePermissionCoordinator");expect(source).not.toContain("__file-write");expect(source).not.toContain("decideFilePermission");
 }
});
