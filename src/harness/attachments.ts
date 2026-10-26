import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { HarnessMessageAttachment } from "./types";

/** 单个附件字节上限；超过它在发送前拒绝，不截断或静默降级。 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 单条消息附件数量上限。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** 预览 data URL 生成上限；更大的合法图片仍可作为附件，仅不生成缩略预览。 */
const PREVIEW_BYTES = 4 * 1024 * 1024;

// 同一Engine暂存区内，绑定与耐久消费不可交错；队列失败不毒化后续请求。
// 批次整体串行，避免多个图片以相反顺序申请逐图片锁而死锁。
const submissions=new Map<string,Promise<void>>();
const consumed=new Map<string,Set<string>>();
/**
 * 在本进程同一暂存区串行完成图片提交事务；不同暂存区互不阻塞。
 * action必须在消息事实耐久后消费暂存，落盘前失败则保留；不等待模型回合。
 */
export async function withAttachmentSubmission<T>(root:string,action:()=>Promise<T>):Promise<T>{
  const key=stagingRoot(root),prior=submissions.get(key)??Promise.resolve();
  let release!:()=>void;
  const current=new Promise<void>(resolve=>{release=resolve;});
  submissions.set(key,current);
  await prior;
  try{return await action();}
  finally{release();if(submissions.get(key)===current)submissions.delete(key);}
}

/** 首版仅支持经 magic bytes 复核的四种图片类型；扩展名与内容必须一致。 */
const IMAGE_TYPES: Record<string, { readonly mime: string; readonly magic: readonly number[] }> = {
  ".png": { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  ".jpg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".jpeg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".gif": { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  ".webp": { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
};

/** 用户选择文件后的待发送描述；只在 Engine 暂存区生成，客户端不能伪造。 */
export type StagedAttachment = {
  /** 暂存身份 UUID；发送时按它取回字节，不传输路径。 */
  readonly stagedId: string;
  /** 原文件名（仅展示，不作为路径）。 */
  readonly name: string;
  /** 经 magic bytes 复核的 MIME。 */
  readonly mimeType: string;
  /** 字节数。 */
  readonly sizeBytes: number;
  /** 内容 SHA-256；发送绑定前复核。 */
  readonly sha256: string;
  /** 小图的预览 data URL；超过预览上限缺省。 */
  readonly previewDataUrl?: string;
};

/** 暂存区根目录：与 harness-runs 同级，随 WAVE_FLOW_HOME 隔离。 */
function stagingRoot(root: string): string {
  return join(resolve(root, ".."), "attachments-staging");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("附件目录必须是真实目录。 ");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("附件目录不属于当前用户。 ");
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

async function writePrivateBytes(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o600);
}

/** Engine 重启后清空暂存区；UI 持有的暂存描述随之失效，发送时如实报错。 */
export async function resetAttachmentStaging(root: string): Promise<void> {
  await rm(stagingRoot(root), { recursive: true, force: true });
  consumed.delete(stagingRoot(root));
}

function assertImageBytes(extension: string, bytes: Buffer): string {
  const type = IMAGE_TYPES[extension];
  if (!type) throw new Error("不支持的文件类型；首版仅支持 PNG、JPEG、GIF、WebP 图片。 ");
  if (bytes.length < type.magic.length + 4 || !type.magic.every((value, index) => bytes[index] === value)) throw new Error("文件内容与扩展名不符，未作为图片附件接受。 ");
  if (extension === ".webp" && bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("文件内容与扩展名不符，未作为图片附件接受。 ");
  return type.mime;
}

/**
 * 把用户显式选择的单个文件复制进 Engine 私有暂存区并返回待发送描述。
 * 选择只读取该文件一次；不遍历目录、不授权其他文件、不自动发送。
 */
export type StageAttachmentIo = {
  /** 解析用户选择的文件路径；测试可注入确定性替身。 */
  readonly realpath: typeof realpath;
  /** 读取路径当前元数据，用于与已打开句柄核对身份。 */
  readonly lstat: typeof lstat;
  /** 以调用方给定 flags 打开文件并返回句柄。 */
  readonly open: typeof open;
};

export async function stageAttachment(root: string, rawPath: string, io: StageAttachmentIo = { realpath, lstat, open }): Promise<StagedAttachment> {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) throw new Error("附件路径无效。 ");
  const path = await io.realpath(rawPath).catch(() => { throw new Error("附件文件不可读取。 "); });
  // lstat 与 readFile 之间存在 TOCTOU：路径可能在检查后被替换或文件被追加增长。
  // 先以 O_NOFOLLOW 打开句柄，再用 lstat 与句柄 fstat 的 dev/ino 对照确认读到的是同一个文件；
  // 打开之后的替换只会影响路径名，不影响已持有的句柄。
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new Error("附件文件不可读取。 "); });
  let bytes: Buffer;
  try {
    const [pathInfo, handleInfo] = await Promise.all([io.lstat(path).catch(() => { throw new Error("附件文件不可读取。 "); }), handle.stat()]);
    if (!handleInfo.isFile()) throw new Error("附件必须是普通文件，不能是目录。 ");
    if (pathInfo.dev !== handleInfo.dev || pathInfo.ino !== handleInfo.ino) throw new Error("附件文件在读取期间被替换，未接受。 ");
    if (handleInfo.size <= 0) throw new Error("附件是空文件，未接受。 ");
    if (handleInfo.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限，未接受。 `);
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  // 读取期间文件可能被追加；实际字节数必须再次强制上限，不能只信打开时的大小。
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限，未接受。 `);
  const mimeType = assertImageBytes(extname(path).toLowerCase(), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stagedId = crypto.randomUUID();
  const directory = join(stagingRoot(root), stagedId);
  await ensurePrivateDirectory(directory);
  await writePrivateBytes(join(directory, "payload"), bytes);
  const descriptor = { name: basename(path), mimeType, sizeBytes: bytes.length, sha256 };
  await writePrivateBytes(join(directory, "descriptor.json"), Buffer.from(JSON.stringify(descriptor), "utf8"));
  return { stagedId, ...descriptor, ...(bytes.length <= PREVIEW_BYTES ? { previewDataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` } : {}) };
}

async function readStaged(root: string, stagedId: string): Promise<{ readonly bytes: Buffer; readonly descriptor: { readonly name: string; readonly mimeType: string; readonly sizeBytes: number; readonly sha256: string } }> {
  if (!/^[a-f0-9-]{36}$/i.test(stagedId)) throw new Error("附件暂存身份无效。 ");
  if(consumed.get(stagingRoot(root))?.has(stagedId))throw new Error("附件暂存已失效，请重新选择文件。 ");
  const directory = join(stagingRoot(root), stagedId);
  const [descriptorRaw, bytes] = await Promise.all([
    readFile(join(directory, "descriptor.json"), "utf8").catch(() => { throw new Error("附件暂存已失效，请重新选择文件。 "); }),
    readFile(join(directory, "payload")).catch(() => { throw new Error("附件暂存已失效，请重新选择文件。 "); }),
  ]);
  const descriptor = JSON.parse(descriptorRaw) as { readonly name: string; readonly mimeType: string; readonly sizeBytes: number; readonly sha256: string };
  if (bytes.length !== descriptor.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw new Error("附件暂存内容已变化，请重新选择文件。 ");
  return { bytes, descriptor };
}

/**
 * 发送绑定前先整批复核，再复制字节到 Harness 档案目录；不消费暂存。
 * 消息事实落盘后由调用方清理暂存，失败可用原身份重试，不会丢失已选图片。
 */
export async function resolveStagedAttachments(root: string, stagedIds: readonly string[], harnessDirectory: string, messageId: string): Promise<HarnessMessageAttachment[]> {
  if (stagedIds.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件。 `);
  if (new Set(stagedIds).size !== stagedIds.length) throw new Error("同一消息不能重复添加同一附件。 ");
  const prepared = await Promise.all(stagedIds.map(stagedId => readStaged(root, stagedId)));
  const attachments: HarnessMessageAttachment[] = [];
  for (const [index, stagedId] of stagedIds.entries()) {
    const { bytes, descriptor } = prepared[index]!;
    const targetDirectory = join(harnessDirectory, "attachments", messageId);
    await ensurePrivateDirectory(targetDirectory);
    const target = join(targetDirectory, stagedId);
    await writePrivateBytes(target, bytes);
    attachments.push({ id: stagedId, name: descriptor.name, mimeType: descriptor.mimeType, sizeBytes: descriptor.sizeBytes, sha256: descriptor.sha256, file: `attachments/${messageId}/${stagedId}` });
  }
  return attachments;
}

/** 仅在消息或队列事实耐久后清理原暂存；清理失败不撤销已经接受的消息。 */
export async function consumeStagedAttachments(root: string, stagedIds: readonly string[]): Promise<void> {
  // 先禁止本进程重用，再尽力回收字节；删除失败不开放第二次消费。
  const key=stagingRoot(root),used=consumed.get(key)??new Set<string>();consumed.set(key,used);
  for(const stagedId of stagedIds)used.add(stagedId);
  for (const stagedId of stagedIds) {
    if (!/^[a-f0-9-]{36}$/i.test(stagedId)) throw new Error("附件暂存身份无效。 ");
    await rm(join(stagingRoot(root), stagedId), { recursive: true, force: true });
    used.delete(stagedId);
  }
  if(!used.size)consumed.delete(key);
}

/** 重开档案时复核耐久附件文件、大小与hash；缺失或同大小篡改均fail closed。 */
export async function verifyMessageAttachments(harnessDirectory: string, attachments: readonly HarnessMessageAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    if (attachment.file.includes("..")) throw new Error("Harness 附件路径不安全。 ");
    const path = join(harnessDirectory, attachment.file);
    const info = await lstat(path).catch(() => { throw new Error(`Harness 附件文件缺失：${attachment.name}。 `); });
    if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.sizeBytes) throw new Error(`Harness 附件文件不完整：${attachment.name}。 `);
    await readAttachmentBase64(harnessDirectory, attachment);
  }
}

/** 读取耐久附件字节用于ACP或预览；每次复核大小与hash，不信任内存缓存。 */
export async function readAttachmentBase64(harnessDirectory: string, attachment: HarnessMessageAttachment): Promise<{ readonly mimeType: string; readonly dataBase64: string }> {
  if (attachment.file.includes("..")) throw new Error("Harness 附件路径不安全。 ");
  const handle = await open(join(harnessDirectory, attachment.file), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== attachment.sizeBytes || info.size > MAX_ATTACHMENT_BYTES) throw new Error(`Harness 附件文件已变化：${attachment.name}。 `);
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length !== attachment.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error(`Harness 附件文件已变化：${attachment.name}。 `);
  return { mimeType: attachment.mimeType, dataBase64: bytes.toString("base64") };
}
