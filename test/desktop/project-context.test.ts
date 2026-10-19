import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readProjectContext } from "../../src/desktop/project-context";

test("主页只读展示当前分支，非Git项目不伪造", async () => {
  const root=await mkdtemp(join(tmpdir(),"wf-project-context-"));
  try {
    expect((await readProjectContext(root)).status).toBe("unavailable");
    Bun.spawnSync(["/usr/bin/git","init","-b","feature/ui",root]);
    expect(await readProjectContext(root)).toEqual({branch:"feature/ui",status:"ready"});
    expect(await readProjectContext(join(root,"missing"))).toEqual({branch:null,status:"unavailable"});
  } finally { await rm(root,{recursive:true,force:true}); }
});
