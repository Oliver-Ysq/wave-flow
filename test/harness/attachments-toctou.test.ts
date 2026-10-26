import { expect, test } from "bun:test";
import { stageAttachment, type StageAttachmentIo } from "../../src/harness/attachments";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

/** 构造 stageAttachment 的受控替身：真实路径、伪造的 lstat 与已打开句柄。 */
function fakeFs(options: { readonly statSize: number; readonly statDev?: number; readonly statIno?: number; readonly bytes: Buffer }): StageAttachmentIo {
  const stat = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, dev: 1, ino: 2, size: options.statSize, mode: 0o100600, uid: typeof process.getuid === "function" ? process.getuid() : 0 };
  const handle = {
    stat: async () => ({ isFile: () => true, dev: options.statDev ?? 1, ino: options.statIno ?? 2, size: options.statSize }),
    readFile: async () => options.bytes,
    writeFile: async () => {},
    sync: async () => {},
    close: async () => {},
  };
  return {
    realpath: async (path: string) => path,
    lstat: async () => stat,
    open: async () => handle,
  } as unknown as StageAttachmentIo;
}

test("lstat 与 readFile 之间文件被替换：dev/ino 不一致必须拒绝", async () => {
  const io = fakeFs({ statSize: PNG_HEAD.length, statIno: 3, bytes: PNG_HEAD });
  await expect(stageAttachment("/tmp/wf-toctou-root", "/tmp/fake.png", io)).rejects.toThrow("被替换");
});

test("读取期间文件增长超过上限：打开时大小合法也必须按实际字节数拒绝", async () => {
  const io = fakeFs({ statSize: 16, bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 1) });
  await expect(stageAttachment("/tmp/wf-toctou-root", "/tmp/fake.png", io)).rejects.toThrow("上限");
});
