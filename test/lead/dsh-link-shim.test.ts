import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDshLinkShim } from "../../src/lead/dsh-link-shim";

test("DSH 主控 shim 写入 scratch、保留既有 NODE_OPTIONS 且不创建硬链接发布", async () => {
  const root = await mkdtemp(join(tmpdir(), "wf-dsh-link-shim-"));
  try {
    const launcher = { id: "dsh-acp", command: "/bin/true", args: [], env: { NODE_OPTIONS: "--max-old-space-size=4096" } };
    const actual = await prepareDshLinkShim(launcher, root);
    const file = join(root, "dsh-link-shim.cjs");
    const source = await readFile(file, "utf8");
    expect(source).toContain("COPYFILE_FICLONE");
    expect(source).toContain("DSH_HOME");
    expect(source).toContain("originalLink(existingPath, newPath)");
    expect(actual.env?.NODE_OPTIONS).toContain("--max-old-space-size=4096");
    expect(actual.env?.NODE_OPTIONS).toContain(`--require=${JSON.stringify(file)}`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
