import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessService } from "../../src/harness/service";
import { HarnessJournal } from "../../src/harness/journal";
import { preflightLocalWorkflow } from "../../src/workflow/preflight-local";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const source = `import { phase } from "wave-flow";
export const meta = { name: "adopt-demo", description: "接管演示", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };
export default async function run(args) { phase("检查"); return {}; }`;

async function idle(service: HarnessService, id: string): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if ((await service.snapshot(id)).status !== "running") return;
    await Bun.sleep(5);
  }
  throw new Error("回合未结束");
}

async function fixture(sourceText = source, accept = true): Promise<{ root: string; service: HarnessService; id: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-adopt-"));
  roots.push(root);
  const service = new HarnessService(root, async (_id, _cwd, _prior, actions) => ({
    isRunning: false,
    subscribe: () => () => {},
    abort: () => {},
    prompt: async () => {
      await actions.proposeWorkflowRevision(sourceText, "接管目标", "只读检查", undefined, 0);
      return "已提交方案";
    },
  }), undefined, async () => ({ fingerprint: "injected-harness-session" }), true);
  const task = await service.startTask(root, { clientRequestId: crypto.randomUUID(), projectId: "p", text: "准备接管" });
  await idle(service, task.harnessRunId);
  if (accept) await service.acceptWorkflowRevision(task.harnessRunId, 1);
  return { root, service, id: task.harnessRunId };
}

test("保存并接管追加 localOrigin 版本、写文件并允许本地重新预检", async () => {
  const { root, service, id } = await fixture();
  try {
    const target = join(root, ".wave-flow", "workflows", "adopt-demo.ts");
    const requestId = crypto.randomUUID();
    const saved = await service.saveAndAdoptRevision(id, { clientRequestId: requestId, revision: 1, path: target });
    expect(saved.workflowRevisions).toHaveLength(2);
    const adopted = saved.workflowRevisions[1]!;
    expect(adopted).toMatchObject({ revision: 2, parentRevision: 1, sourceFormat: "module", exportRequestId: requestId });
    expect(adopted.localOrigin?.path).toBe(await preflightLocalWorkflow(target, root).then((item) => item.path));
    expect(await readFile(target, "utf8")).toBe(source);
    expect(await preflightLocalWorkflow(target, root).then((item) => item.sourceHash)).toBe(adopted.sourceHash);

    // 同一 UUID 与载荷重试返回原快照，不追加第三个版本。
    const retry = await service.saveAndAdoptRevision(id, { clientRequestId: requestId, revision: 1, path: target });
    expect(retry.workflowRevisions).toHaveLength(2);

    // 接管后按本地来源规则编辑文件并重新预检，主控不能替换源码。
    const edited = source.replace("接管演示", "接管后编辑");
    await writeFile(target, edited, "utf8");
    const checked = await preflightLocalWorkflow(target, root);
    const revised = await service.reviseLocalTask(id, { clientRequestId: crypto.randomUUID(), baseRevision: 2, sourceHash: checked.sourceHash, input: {} });
    expect(revised.workflowRevisions).toHaveLength(3);
    expect(revised.workflowRevisions[2]).toMatchObject({ parentRevision: 2, sourceFormat: "module", source: edited });
    expect(revised.workflowRevisions[2]?.localOrigin?.path).toBe(checked.path);
  } finally { service.close(); }
});

test("保存并接管携带用户输入并按冻结 Schema 校验", async () => {
  const required = `import { phase } from "wave-flow";
export const meta = { name: "adopt-required", description: "必填输入", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } };
export default async function run(args) { phase("检查"); return { note: args.note }; }`;
  const { root, service, id } = await fixture(required);
  try {
    const target = join(root, "adopt-required.ts");
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: target })).rejects.toThrow("参数无效");
    const saved = await service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: target, input: { note: "来自用户" } });
    expect(saved.workflowRevisions[1]?.input).toEqual({ note: "来自用户" });
  } finally { service.close(); }
});

test("Tauri 保存对话框权限与保存接管 action 已接线", async () => {
  const capabilities = await Bun.file("src-tauri/capabilities/default.json").json() as { permissions: string[] };
  expect(capabilities.permissions).toContain("dialog:allow-save");
  const api = await Bun.file("src-tauri/web/src/api.ts").text();
  expect(api).toContain('"workflows.saveAndAdoptRevision"');
  // 系统保存面板返回路径不等于“用户已确认替换”：UI 先按新建提交，只有引擎判定目标已存在时才按替换重试。
  expect(api).toContain("...(replace ? { replace } : {})");
  const card = await Bun.file("src-tauri/web/src/conversation/revision-card.tsx").text();
  expect(card).toContain("inputDraft,replace)");
  expect(card).toContain("await attempt(false)");
  expect(card).toContain('includes("已存在")');
  // 保存成功后自动预检并生成可确认版本；失败时回到手动入口。
  expect(card).toContain('crypto.randomUUID(),undefined,"save-local"');
  expect(card).toContain("自动预检未完成");
  // 待确认版本已由保存/自动预检准备好，不再显示容易误导的“重新预检”按钮。
  expect(card).toContain("(revision.acceptedAt!==null||sourceDrift)&&onLocalRevision");
});

test("保存并接管拒绝冲突载荷、已存在文件与过期版本，且不改变 Task", async () => {
  const { root, service, id } = await fixture();
  try {
    const target = join(root, "adopt-demo.ts");
    await writeFile(target, "existing", "utf8");
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: target })).rejects.toThrow("已存在");
    expect((await service.snapshot(id)).workflowRevisions).toHaveLength(1);

    const requestId = crypto.randomUUID();
    const saved = await service.saveAndAdoptRevision(id, { clientRequestId: requestId, revision: 1, path: join(root, "adopt-ok.ts") });
    expect(saved.workflowRevisions).toHaveLength(2);
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: requestId, revision: 1, path: join(root, "other.ts") })).rejects.toThrow("载荷冲突");
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: join(root, "late.ts") })).rejects.toThrow("最新");
  } finally { service.close(); }
});

test("用户在系统面板确认替换后保存接管覆盖目标文件", async () => {
  const { root, service, id } = await fixture();
  try {
    const target = join(root, "adopt-demo.ts");
    await writeFile(target, "旧内容", "utf8");
    // 未确认替换仍拒绝，避免静默覆盖。
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: target })).rejects.toThrow("已存在");

    const requestId = crypto.randomUUID();
    const saved = await service.saveAndAdoptRevision(id, { clientRequestId: requestId, revision: 1, path: target, replace: true });
    expect(saved.workflowRevisions).toHaveLength(2);
    expect(saved.workflowRevisions[1]?.localOrigin?.path).toBe(await preflightLocalWorkflow(target, root).then((item) => item.path));
    expect(await readFile(target, "utf8")).toBe(source);
    // 同 UUID 幂等重试不再重复写入。
    expect((await service.saveAndAdoptRevision(id, { clientRequestId: requestId, revision: 1, path: target, replace: true })).workflowRevisions).toHaveLength(2);
  } finally { service.close(); }
});

test("替换只允许常规文件：软链接与目录一律拒绝", async () => {
  const { root, service, id } = await fixture();
  try {
    const outside = join(root, "outside.ts");
    await writeFile(outside, "外部", "utf8");
    const linkPath = join(root, "link.ts");
    await symlink(outside, linkPath);
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: linkPath, replace: true })).rejects.toThrow("常规文件");
    const directory = join(root, "dir.ts");
    await mkdir(directory);
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: directory, replace: true })).rejects.toThrow("常规文件");
    expect((await service.snapshot(id)).workflowRevisions).toHaveLength(1);
    expect(await readFile(outside, "utf8")).toBe("外部");
  } finally { service.close(); }
});

test("保存接管后自动预检生成可确认版本，并标记为保存本地来源", async () => {
  const { root, service, id } = await fixture();
  try {
    const target = join(root, "auto-preflight.ts");
    const saved = await service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: target });
    const adopted = saved.workflowRevisions.at(-1)!;
    expect(adopted.revision).toBe(2);
    // 模拟 UI 保存成功后立即以同一文件预检。
    const prepared = await service.reviseLocalTask(id, { clientRequestId: crypto.randomUUID(), baseRevision: adopted.revision, sourceHash: adopted.localOrigin!.sourceHash, input: {}, updateReason: "save-local" });
    expect(prepared.workflowRevisions).toHaveLength(3);
    const next = prepared.workflowRevisions[2]!;
    expect(next).toMatchObject({ parentRevision: 2, updateReason: "save-local", acceptedAt: null });
    expect(next.localOrigin?.path).toBe(adopted.localOrigin?.path);
    expect(next.localOrigin?.sourceHash).toBe(adopted.localOrigin?.sourceHash);
    // 缺省原因仍按源码/参数推断，自动标记不影响普通修订。
    const manual = await service.reviseLocalTask(id, { clientRequestId: crypto.randomUUID(), baseRevision: 3, sourceHash: next.localOrigin!.sourceHash, input: {} });
    expect(manual.workflowRevisions[3]?.updateReason).toBe("modify-parameters");
  } finally { service.close(); }
});

test("已拒绝的草案不能被保存接管", async () => {
  const { root, service, id } = await fixture(source, false);
  try {
    await service.rejectWorkflowRevision(id, 1);
    await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: join(root, "rejected.ts") })).rejects.toThrow("未拒绝");
    expect((await service.snapshot(id)).workflowRevisions).toHaveLength(1);
    await expect(readFile(join(root, "rejected.ts"), "utf8")).rejects.toThrow();
  } finally { service.close(); }
});

test("替换保存保留原文件权限", async () => {
  const { root, service, id } = await fixture();
  try {
    const target = join(root, "mode.ts");
    await writeFile(target, "旧内容", "utf8");
    await chmod(target, 0o600);
    await service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: target, replace: true });
    expect(await readFile(target, "utf8")).toBe(source);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  } finally { service.close(); }
});

test("Journal 追加失败时回滚替换与新建，不留下半成品", async () => {
  const { root, service, id } = await fixture();
  const journalDir = (await HarnessJournal.open(id, root)).journal.directory;
  const journalFile = join(journalDir, "journal.jsonl");
  try {
    // 用目录不可写做实例级注入，避免 spy 原型污染并发测试。
    const replaced = join(root, "rollback-replace.ts");
    await writeFile(replaced, "旧内容", "utf8");
    await chmod(journalFile, 0o400);
    try {
      await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: replaced, replace: true })).rejects.toThrow();
    } finally { await chmod(journalFile, 0o600); }
    expect(await readFile(replaced, "utf8")).toBe("旧内容");
    expect((await service.snapshot(id)).workflowRevisions).toHaveLength(1);

    const created = join(root, "rollback-create.ts");
    await chmod(journalFile, 0o400);
    try {
      await expect(service.saveAndAdoptRevision(id, { clientRequestId: crypto.randomUUID(), revision: 1, path: created })).rejects.toThrow();
    } finally { await chmod(journalFile, 0o600); }
    await expect(readFile(created, "utf8")).rejects.toThrow();
    expect((await service.snapshot(id)).workflowRevisions).toHaveLength(1);
  } finally { service.close(); }
});
