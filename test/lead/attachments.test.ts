import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { LeadJournal } from "../../src/lead/journal";
import { LeadService } from "../../src/lead/service";
import type { LeadSession } from "../../src/lead/session";
import type { LeadPromptAttachment } from "../../src/lead/session";
import type { LeadStreamEvent } from "../../src/lead/types";
import { leadRunsRoot } from "../../src/journal/paths";
import { resolveStagedAttachments } from "../../src/lead/attachments";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** 1×1 合法 PNG（magic + 最小体）。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

/** 能力可配的主控会话；记录每次 prompt 收到的附件。 */
class AttachmentPi implements LeadSession {
  constructor(readonly promptImageCapable: boolean | undefined) {}
  #listeners = new Set<(event: LeadStreamEvent) => void>();
  #resolve: ((value: string) => void) | null = null;
  isRunning = false;
  prepared = false;
  readonly prompts: string[] = [];
  readonly received: (readonly LeadPromptAttachment[])[] = [];
  subscribe(listener: (event: LeadStreamEvent) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async prepare() { this.prepared = true; }
  prompt(text: string, attachments: readonly LeadPromptAttachment[] = []): Promise<string> {
    this.prompts.push(text);
    this.received.push(attachments);
    this.isRunning = true;
    return new Promise((resolve) => { this.#resolve = resolve; });
  }
  finish(text = "durable answer") { this.isRunning = false; this.#resolve?.(text); this.#resolve = null; }
  abort() { this.isRunning = false; }
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

async function makeImageFile(name = "photo.png", bytes: Buffer = PNG_BYTES): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "wave-flow-pick-")), name);
  await writeFile(path, bytes);
  return path;
}

describe("Lead 附件与多模态消息", () => {
  test("跨Task并发消费同暂存只有一条消息，同消息UUID并发重试幂等",async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'wf-attach-race-'));directories.push(cwd);
    const root=leadRunsRoot(cwd),sessions:AttachmentPi[]=[];
    const service=new LeadService(root,async()=>{const session=new AttachmentPi(true);sessions.push(session);return session;});
    const a=await service.create(cwd),b=await service.create(cwd),staged=await service.stageAttachment(await makeImageFile());
    const outcomes=await Promise.allSettled([service.submit(a.leadRunId,'A',{stagedAttachmentIds:[staged.stagedId]}),service.submit(b.leadRunId,'B',{stagedAttachmentIds:[staged.stagedId]})]);
    expect(outcomes.map(item=>item.status).sort()).toEqual(['fulfilled','rejected']);
    expect((await service.snapshot(a.leadRunId)).messages.filter(item=>item.role==='user').length+(await service.snapshot(b.leadRunId)).messages.filter(item=>item.role==='user').length).toBe(1);
    await waitFor(()=>sessions.some(session=>session.prompts.length===1),'跨任务模拟prompt已建立');
    sessions.forEach(session=>session.finish());
    await waitFor(async()=>[await service.snapshot(a.leadRunId),await service.snapshot(b.leadRunId)].every(item=>item.status!=='running'),'跨任务回合耐久收尾');
    const c=await service.create(cwd),second=await service.stageAttachment(await makeImageFile());
    const options={clientMessageId:crypto.randomUUID(),stagedAttachmentIds:[second.stagedId]};
    await Promise.all([service.submit(c.leadRunId,'C',options),service.submit(c.leadRunId,'C',options)]);
    expect((await service.snapshot(c.leadRunId)).messages.filter(item=>item.role==='user')).toHaveLength(1);
    await waitFor(()=>sessions.filter(session=>session.prompts.length===1).length===2,'幂等模拟prompt已建立');
    sessions.forEach(session=>session.finish());
    await waitFor(async()=>(await service.snapshot(c.leadRunId)).status==='idle','幂等回合耐久收尾');
    service.close();
  });

  test("逆序多附件批次并发无死锁，失败批次保留未消费图片供重试",async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'wf-attach-batch-race-'));directories.push(cwd);
    const service=new LeadService(leadRunsRoot(cwd),async()=>new AttachmentPi(true));
    const a=await service.create(cwd),b=await service.create(cwd);
    const x=await service.stageAttachment(await makeImageFile()),y=await service.stageAttachment(await makeImageFile());
    const result=await Promise.allSettled([service.submit(a.leadRunId,'XY',{stagedAttachmentIds:[x.stagedId,y.stagedId]}),service.submit(b.leadRunId,'YX',{stagedAttachmentIds:[y.stagedId,x.stagedId]})]);
    expect(result.map(item=>item.status).sort()).toEqual(['fulfilled','rejected']);
    const z=await service.stageAttachment(await makeImageFile());
    await expect(service.submit(b.leadRunId,'invalid',{stagedAttachmentIds:[z.stagedId,x.stagedId]})).rejects.toThrow('失效');
    await service.submit(b.leadRunId,'retry',{stagedAttachmentIds:[z.stagedId]});
    expect((await service.snapshot(b.leadRunId)).messages.filter(item=>item.role==='user')).toHaveLength(1);
  });
  test("整批绑定失败保留先前图片，零消息零prompt，重试仍可使用原暂存", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wf-attach-batch-")); directories.push(cwd);
    const root = leadRunsRoot(cwd), session = new AttachmentPi(true);
    const service = new LeadService(root, async () => session);
    const created = await service.create(cwd);
    const staged = await service.stageAttachment(await makeImageFile());
    await expect(service.submit(created.leadRunId, "两张图片", { stagedAttachmentIds: [staged.stagedId, crypto.randomUUID()] })).rejects.toThrow("失效");
    expect((await service.snapshot(created.leadRunId)).messages).toHaveLength(0);
    expect(session.prompts).toHaveLength(0);
    await service.submit(created.leadRunId, "原图重试", { stagedAttachmentIds: [staged.stagedId] });
    await waitFor(() => session.prompts.length === 1, "失败后原图重试");
    expect(session.received[0]).toHaveLength(1);
    session.finish();
    await waitFor(async () => (await service.snapshot(created.leadRunId)).status === "idle", "结束");
  });

  test("仅复制附件但未建立消息事实时原暂存仍可重新绑定，重复身份拒绝", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wf-attach-uncommitted-")); directories.push(cwd);
    const root = leadRunsRoot(cwd), service = new LeadService(root, async () => new AttachmentPi(true));
    const created = await service.create(cwd), staged = await service.stageAttachment(await makeImageFile());
    const directory = (await LeadJournal.open(created.leadRunId, root)).journal.directory;
    const id = crypto.randomUUID();
    const first = await resolveStagedAttachments(root, [staged.stagedId], directory, id);
    expect(await resolveStagedAttachments(root, [staged.stagedId], directory, id)).toEqual(first);
    expect((await service.snapshot(created.leadRunId)).messages).toHaveLength(0);
    await expect(resolveStagedAttachments(root, [staged.stagedId, staged.stagedId], directory, id)).rejects.toThrow("重复");
  });

  test("用户消息Journal落盘失败保留原图，显式同ID重试只产生一条消息", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wf-attach-journal-fail-")); directories.push(cwd);
    const root = leadRunsRoot(cwd), session = new AttachmentPi(true);
    const service = new LeadService(root, async () => session);
    const created = await service.create(cwd), staged = await service.stageAttachment(await makeImageFile());
    const options = { clientMessageId: crypto.randomUUID(), stagedAttachmentIds: [staged.stagedId] };
    const original = LeadJournal.prototype.append;
    try {
      LeadJournal.prototype.append = async function(event) {
        if (this.manifest.leadRunId === created.leadRunId && event.type === "lead.user_message") throw new Error("injected journal failure");
        return original.call(this, event);
      };
      await expect(service.submit(created.leadRunId, "图片", options)).rejects.toThrow("journal failure");
    } finally { LeadJournal.prototype.append = original; }
    expect((await service.snapshot(created.leadRunId)).messages).toHaveLength(0);
    expect(session.prompts).toHaveLength(0);
    await service.submit(created.leadRunId, "图片", options);
    await waitFor(() => session.prompts.length === 1, "显式重试");
    expect(session.received[0]).toHaveLength(1);
    expect((await service.snapshot(created.leadRunId)).messages.filter(item => item.role === "user")).toHaveLength(1);
    session.finish();
    await waitFor(async () => (await service.snapshot(created.leadRunId)).status === "idle", "结束");
  });

  test("同大小附件被篡改时预览与档案重开均拒绝", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wf-attach-hash-")); directories.push(cwd);
    const root = leadRunsRoot(cwd), session = new AttachmentPi(true);
    const service = new LeadService(root, async () => session);
    const created = await service.create(cwd), staged = await service.stageAttachment(await makeImageFile());
    await service.submit(created.leadRunId, "图片", { stagedAttachmentIds: [staged.stagedId] });
    await waitFor(() => session.prompts.length === 1, "投递"); session.finish();
    await waitFor(async () => (await service.snapshot(created.leadRunId)).status === "idle", "结束");
    const opened = await LeadJournal.open(created.leadRunId, root), message = opened.snapshot.messages[0]!;
    const attachment = message.attachments![0]!, changed = Buffer.from(PNG_BYTES);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await writeFile(join(opened.journal.directory, attachment.file), changed);
    await expect(service.attachmentData(created.leadRunId, message.id, attachment.id)).rejects.toThrow("已变化");
    await expect(LeadJournal.open(created.leadRunId, root)).rejects.toThrow("已变化");
  });
  test("首条图片初始化失败保留暂存，显式重试仍携带原图且不追加纯文本消息",async()=>{
    const cwd=await mkdtemp(join(tmpdir(),"wf-initial-retry-"));directories.push(cwd);
    let fail=true;const session=new AttachmentPi(true);
    const service=new LeadService(leadRunsRoot(cwd),async()=>{if(fail)throw new Error("offline");return session;});
    const staged=await service.stageAttachment(await makeImageFile());
    const snapshot=await service.startTask(cwd,{clientRequestId:crypto.randomUUID(),projectId:"project",text:"描述图",stagedAttachmentIds:[staged.stagedId]});
    expect(snapshot.messages).toHaveLength(0);expect(snapshot.diagnostic).toContain("offline");
    const reopened=await LeadJournal.open(snapshot.leadRunId,leadRunsRoot(cwd));
    expect(reopened.snapshot.task?.initialAttachmentIds).toEqual([staged.stagedId]);
    fail=false;await service.retryInitialization(snapshot.leadRunId);
    await waitFor(()=>session.prompts.length===1,"原图重试");expect(session.received[0]).toHaveLength(1);
    session.finish();await waitFor(async()=>(await service.snapshot(snapshot.leadRunId)).status==="idle","完成");
    expect((await service.snapshot(snapshot.leadRunId)).messages.filter(item=>item.role==="user")).toHaveLength(1);
  });
  test("首条附件失效时重试明确拒绝，不退化为文字投递",async()=>{
    const cwd=await mkdtemp(join(tmpdir(),"wf-initial-missing-"));directories.push(cwd);
    const root=leadRunsRoot(cwd),session=new AttachmentPi(true);let fail=true;
    const service=new LeadService(root,async()=>{if(fail)throw new Error("offline");return session;});
    const staged=await service.stageAttachment(await makeImageFile());
    const snapshot=await service.startTask(cwd,{clientRequestId:crypto.randomUUID(),projectId:"project",text:"描述图",stagedAttachmentIds:[staged.stagedId]});
    await service.resetAttachmentStaging();
    fail=false;const retried=await service.retryInitialization(snapshot.leadRunId);
    expect(retried.diagnostic).toContain("失效");expect(retried.messages).toHaveLength(0);expect(session.prompts).toHaveLength(0);
  });
  test("主页首条消息携带图片，同创建UUID重试不重复发送", async () => {
    const cwd=await mkdtemp(join(tmpdir(),"wf-first-image-")); directories.push(cwd);
    const root=leadRunsRoot(cwd), session=new AttachmentPi(true);
    const service=new LeadService(root,async()=>session);
    const staged=await service.stageAttachment(await makeImageFile());
    const request={clientRequestId:crypto.randomUUID(),projectId:"project",text:"描述图片",stagedAttachmentIds:[staged.stagedId]};
    const snapshot=await service.startTask(cwd,request);
    expect(snapshot.diagnostic).toBeNull();
    await waitFor(()=>session.prompts.length===1,"首条图片投递");
    expect(session.received[0]).toHaveLength(1);
    session.finish();
    await waitFor(async()=>(await service.snapshot(snapshot.leadRunId)).status==="idle","首条回合完成");
    const retried=await service.startTask(cwd,request);
    expect(retried.messages.filter(item=>item.role==="user")).toHaveLength(1);
    expect(session.prompts).toHaveLength(1);
    const directory = (await LeadJournal.open(snapshot.leadRunId, root)).journal.directory;
    await rm(join(directory,"journal.jsonl"));
    await expect(service.startTask(cwd,request)).rejects.toThrow("Journal 缺失");
    expect(session.prompts).toHaveLength(1);
  });
  test("选择只创建暂存；发送时耐久绑定并经能力验证的会话投递图片", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-attach-")); directories.push(cwd);
    const root = leadRunsRoot(cwd);
    const sessions: AttachmentPi[] = [];
    const service = new LeadService(root, async () => { const session = new AttachmentPi(true); sessions.push(session); return session; });
    const created = await service.create(cwd);
    const imagePath = await makeImageFile();

    const staged = await service.stageAttachment(imagePath);
    expect(staged.mimeType).toBe("image/png");
    expect(staged.sizeBytes).toBe(PNG_BYTES.length);
    expect(staged.previewDataUrl).toContain("data:image/png;base64,");
    // 选择不产生任何会话或消息事实。
    expect(sessions).toHaveLength(0);
    expect((await service.snapshot(created.leadRunId)).messages).toHaveLength(0);

    const snapshot = await service.submit(created.leadRunId, "请描述这张图", { stagedAttachmentIds: [staged.stagedId] });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prepared).toBe(true);
    await waitFor(() => sessions[0]!.prompts.length === 1, "回合开始");
    sessions[0]!.finish("answer");
    await waitFor(async () => (await service.snapshot(created.leadRunId)).status === "idle", "回合收敛");

    expect(sessions[0]!.received[0]).toHaveLength(1);
    expect(sessions[0]!.received[0]![0]!.mimeType).toBe("image/png");
    expect(Buffer.from(sessions[0]!.received[0]![0]!.dataBase64, "base64").equals(PNG_BYTES)).toBe(true);

    const message = snapshot.messages[0]!;
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0]!.file).toBe(`attachments/${message.id}/${staged.stagedId}`);
    // 耐久字节与回放一致；重开档案不报错且元数据相同。
    const opened = await LeadJournal.open(created.leadRunId, root);
    expect(opened.snapshot.messages[0]!.attachments).toEqual(message.attachments);
    const info = await lstat(join(opened.journal.directory, message.attachments![0]!.file));
    expect(info.size).toBe(PNG_BYTES.length);
    // 暂存区已清空，同一 stagedId 不能再次使用。
    await expect(service.submit(created.leadRunId, "再次使用", { stagedAttachmentIds: [staged.stagedId] })).rejects.toThrow("已失效");
  });

  test("能力未验证支持时发送前拒绝：零消息事实且未绑定档案附件", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-attach-")); directories.push(cwd);
    const root = leadRunsRoot(cwd);
    const service = new LeadService(root, async () => new AttachmentPi(false));
    const created = await service.create(cwd);
    const staged = await service.stageAttachment(await makeImageFile());

    await expect(service.submit(created.leadRunId, "带图消息", { stagedAttachmentIds: [staged.stagedId] })).rejects.toThrow("未验证支持图片附件");
    const opened = await LeadJournal.open(created.leadRunId, root);
    expect(opened.events.filter((event) => event.type === "lead.user_message" || event.type === "lead.message_queued")).toHaveLength(0);
    expect((await service.snapshot(created.leadRunId)).messageQueue).toHaveLength(0);

    // 能力未知（undefined）同样 fail closed，不能冒充支持。
    const service2 = new LeadService(root, async () => new AttachmentPi(undefined));
    const created2 = await service2.create(cwd);
    const staged2 = await service2.stageAttachment(await makeImageFile());
    await expect(service2.submit(created2.leadRunId, "带图消息", { stagedAttachmentIds: [staged2.stagedId] })).rejects.toThrow("未验证支持图片附件");
  });

  test("选择校验：目录、过大、非图片与内容不符一律在暂存前拒绝", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-attach-")); directories.push(cwd);
    const root = leadRunsRoot(cwd);
    const service = new LeadService(root, async () => new AttachmentPi(true));
    await service.create(cwd);

    await expect(service.stageAttachment(cwd)).rejects.toThrow("普通文件");
    await expect(service.stageAttachment(join(cwd, "missing.png"))).rejects.toThrow("不可读取");
    await expect(service.stageAttachment(await makeImageFile("note.txt"))).rejects.toThrow("不支持的文件类型");
    await expect(service.stageAttachment(await makeImageFile("fake.png", Buffer.from("not a png at all........")))).rejects.toThrow("内容");
    const oversized = join(cwd, "big.png");
    await writeFile(oversized, Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]));
    await expect(service.stageAttachment(oversized)).rejects.toThrow("上限");
  });

  test("忙碌时带附件消息耐久入队，回合结束后随派发投递附件", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-attach-")); directories.push(cwd);
    const root = leadRunsRoot(cwd);
    const sessions: AttachmentPi[] = [];
    const service = new LeadService(root, async () => { const session = new AttachmentPi(true); sessions.push(session); return session; });
    const created = await service.create(cwd);
    await service.submit(created.leadRunId, "first");
    await waitFor(() => sessions[0]!.prompts.length === 1, "首个回合开始");

    const staged = await service.stageAttachment(await makeImageFile());
    const queued = await service.submit(created.leadRunId, "queued with image", { stagedAttachmentIds: [staged.stagedId] });
    expect(queued.messageQueue).toHaveLength(1);
    expect(queued.messageQueue[0]!.message.attachments).toHaveLength(1);

    sessions[0]!.finish("answer-1");
    await waitFor(() => sessions[0]!.prompts.length === 2, "排队消息投递");
    expect(sessions[0]!.received[1]).toHaveLength(1);
    sessions[0]!.finish("answer-2");
    await waitFor(async () => (await service.snapshot(created.leadRunId)).status === "idle", "全部收敛");
    const opened = await LeadJournal.open(created.leadRunId, root);
    expect(opened.snapshot.messages.map((message) => message.text)).toEqual(["first", "answer-1", "queued with image", "answer-2"]);
  });

  test("Engine 重启后队列中的附件消息恢复投递，附件字节可核验", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-attach-")); directories.push(cwd);
    const root = leadRunsRoot(cwd);
    const first: AttachmentPi[] = [];
    const service = new LeadService(root, async () => { const session = new AttachmentPi(true); first.push(session); return session; });
    const created = await service.create(cwd);
    await service.submit(created.leadRunId, "first");
    await waitFor(() => first[0]!.prompts.length === 1, "首个回合开始");
    const staged = await service.stageAttachment(await makeImageFile());
    await service.submit(created.leadRunId, "queued with image", { stagedAttachmentIds: [staged.stagedId] });

    const restarted: AttachmentPi[] = [];
    const service2 = new LeadService(root, async () => { const session = new AttachmentPi(true); restarted.push(session); return session; });
    await service2.convergeStaleTurns();
    await service2.resumeMessageQueues();
    await waitFor(() => restarted.length === 1 && restarted[0]!.prompts.length === 1, "重启后投递");
    expect(restarted[0]!.received[0]).toHaveLength(1);
    expect(restarted[0]!.received[0]![0]!.mimeType).toBe("image/png");
    restarted[0]!.finish("answer");
    await waitFor(async () => (await service2.snapshot(created.leadRunId)).status === "idle", "收敛");
  });

  test("attachmentData 只读已绑定附件；篡改路径的档案重开 fail closed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-attach-")); directories.push(cwd);
    const root = leadRunsRoot(cwd);
    const sessions: AttachmentPi[] = [];
    const service = new LeadService(root, async () => { const session = new AttachmentPi(true); sessions.push(session); return session; });
    const created = await service.create(cwd);
    const staged = await service.stageAttachment(await makeImageFile());
    await service.submit(created.leadRunId, "带图", { stagedAttachmentIds: [staged.stagedId] });
    await waitFor(() => sessions[0]!.prompts.length === 1, "回合开始");
    sessions[0]!.finish("answer");
    await waitFor(async () => (await service.snapshot(created.leadRunId)).status === "idle", "收敛");

    const message = (await service.snapshot(created.leadRunId)).messages[0]!;
    const data = await service.attachmentData(created.leadRunId, message.id, message.attachments![0]!.id);
    expect(data.dataUrl).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    await expect(service.attachmentData(created.leadRunId, message.id, crypto.randomUUID())).rejects.toThrow("不存在");

    // 删除耐久附件字节后重开必须拒绝，不能假装附件仍在。
    await rm(join((await LeadJournal.open(created.leadRunId, root)).journal.directory, message.attachments![0]!.file));
    await expect(LeadJournal.open(created.leadRunId, root)).rejects.toThrow("附件文件缺失");
  });
});
