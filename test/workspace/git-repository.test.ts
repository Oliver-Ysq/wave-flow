import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitRepository, type GitSaveRequest } from "../../src/workspace/git-repository";

// 真实Git进程验证不是内存单测，保留明确15s总预算。
const test = (name: string, run: () => Promise<void>, timeout = 15_000) => bunTest(name, run, timeout);

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(stderr); return stdout.trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-git-test-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd); await git(cwd, "init", "-b", "main");
  await writeFile(join(cwd, "a.txt"), "base\n"); await writeFile(join(cwd, "b.txt"), "base\n");
  await git(cwd, "add", "--", "a.txt", "b.txt"); await git(cwd, "commit", "-m", "fixture");
  const repo = await GitRepository.open(cwd), base = (await repo.inspect()).head;
  const request: GitSaveRequest = { requestId: crypto.randomUUID(), baseCommit: base, startCommit: base };
  return { root, cwd, repo, base, request };
}

test("显式squash合入已checkout主分支，单父/同请求幂等，未跟踪与dirty不覆盖", async () => {
 const {root,cwd,repo,base,request}=await fixture();
 const worker=await repo.createWorktree(join(root,"worker"),"codex/wf-worker",base);
 await writeFile(join(worker.cwd,"a.txt"),"result\n");
 const saved=await worker.save(request), input={requestId:crypto.randomUUID(),baseCommit:base,sourceCommit:saved.commit,targetBranch:"main",targetHead:base};
 const review=await repo.review(base,saved.commit);expect(review.paths).toEqual(["a.txt"]);expect(review.targets).toEqual([{branch:"main",head:base}]);
 expect((await repo.fileDiff(base,saved.commit,"a.txt")).patch).toContain("+result");
 await expect(repo.fileDiff(base,saved.commit,".git/config")).rejects.toThrow("不属于");
 await writeFile(join(cwd,"user.txt"),"keep");await expect(repo.mergeSquash(input)).rejects.toThrow("未提交");expect(await Bun.file(join(cwd,"user.txt")).text()).toBe("keep");await rm(join(cwd,"user.txt"));
 await writeFile(join(cwd,"b.txt"),"dirty\n");await git(cwd,"add","b.txt");await expect(repo.mergeSquash(input)).rejects.toThrow("未提交");expect(await Bun.file(join(cwd,"b.txt")).text()).toBe("dirty\n");await git(cwd,"restore","--staged","b.txt");await writeFile(join(cwd,"b.txt"),"base\n");
  await writeFile(join(cwd,"b.txt"),"staged\n");await git(cwd,"add","b.txt");await writeFile(join(cwd,"b.txt"),"base\n");expect((await repo.inspect()).changedPaths).toEqual(["b.txt"]);await expect(repo.mergeSquash(input)).rejects.toThrow("未提交/暂存");await git(cwd,"restore","--staged","b.txt");
 const merged=await repo.mergeSquash(input);expect(await repo.mergeSquash(input)).toEqual(merged);
 expect(await git(cwd,"show","-s","--format=%P",merged.commit)).toBe(base);expect(await git(cwd,"rev-list","--count",`${base}..main`)).toBe("1");
 expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("result\n");expect((await repo.inspect()).changedPaths).toEqual([]);
 await expect(repo.mergeSquash({...input,requestId:crypto.randomUUID()})).rejects.toThrow("已变化");
});
test("未checkout目标仅CAS ref；目标前进拒绝，二进制diff明确省略",async()=>{
 const {root,cwd,repo,base,request}=await fixture();await git(cwd,"branch","target");
 const worker=await repo.createWorktree(join(root,"worker"),"codex/wf-worker",base);await writeFile(join(worker.cwd,"image.bin"),Buffer.from([0,1,2]));const saved=await worker.save(request);
 expect(await repo.fileDiff(base,saved.commit,"image.bin")).toMatchObject({omitted:true,reason:"binary"});
 const merged=await repo.mergeSquash({requestId:crypto.randomUUID(),baseCommit:base,sourceCommit:saved.commit,targetBranch:"target",targetHead:base});
 expect((await repo.inspect()).head).toBe(base);expect(await git(cwd,"rev-parse","target")).toBe(merged.commit);
 await expect(repo.mergeSquash({requestId:crypto.randomUUID(),baseCommit:base,sourceCommit:saved.commit,targetBranch:"target",targetHead:merged.commit})).rejects.toThrow("偏离");
});
test("大文本diff明确省略而不丢失成果文件，已跟踪ignored依赖仍保存",async()=>{
 const {root,cwd,repo}=await fixture();await mkdir(join(cwd,"node_modules"));await writeFile(join(cwd,"node_modules","tracked.txt"),"base\n");await git(cwd,"add","node_modules/tracked.txt");await git(cwd,"commit","-m","tracked fixture");const base=(await repo.inspect()).head;
 const worker=await repo.createWorktree(join(root,"worker"),"codex/wf-worker",base);await writeFile(join(worker.cwd,".gitignore"),"node_modules/\n");await writeFile(join(worker.cwd,"node_modules","tracked.txt"),"changed\n");await writeFile(join(worker.cwd,"large.txt"),"line content\n".repeat(170000));
 const saved=await worker.save({requestId:crypto.randomUUID(),baseCommit:base,startCommit:base});expect(saved.paths).toContain("node_modules/tracked.txt");expect(saved.paths).toContain("large.txt");expect(await repo.fileDiff(base,saved.commit,"large.txt")).toMatchObject({omitted:true,reason:"too-large",patch:""});
},20000);
test("tracked始终纳入，gitignored和未跟踪node_modules不收集，特殊路径通过NUL暂存",async()=>{
 const {root,cwd,repo,base}=await fixture();const worker=await repo.createWorktree(join(root,"worker"),"codex/wf-worker",base);
 await writeFile(join(worker.cwd,".gitignore"),"*.log\n");await writeFile(join(worker.cwd,"debug.log"),"ignored");await mkdir(join(worker.cwd,"node_modules"));await writeFile(join(worker.cwd,"node_modules","dep"),"ignored dependency");await writeFile(join(worker.cwd,"[x] space.ts"),"new");
 const saved=await worker.save({requestId:crypto.randomUUID(),baseCommit:base,startCommit:base});expect(saved.paths).toEqual([".gitignore","[x] space.ts"]);expect((await worker.inspect()).changedPaths).toEqual([]);
 expect(await Bun.file(join(worker.cwd,"debug.log")).text()).toBe("ignored");expect((await repo.inspect()).head).toBe(base);
});
test("候选已冻结但ref更新失败时，重试拒绝新增成果；恢复原tree后保存同候选",async()=>{
 const {root,repo,base,request}=await fixture(),worker=await repo.createWorktree(join(root,"worker"),"codex/wf-worker",base);
 await writeFile(join(worker.cwd,"a.txt"),"frozen\n");
 const original=Bun.spawn, injected=spyOn(Bun,"spawn").mockImplementation((...args:any[])=>{const argv=args[0];if(Array.isArray(argv)&&argv.includes("update-ref"))throw Error("fixture ref unavailable");return (original as any)(...args);});
 try{await expect(worker.save(request)).rejects.toThrow("fixture ref unavailable");}finally{injected.mockRestore();}
 await writeFile(join(worker.cwd,"extra.txt"),"late");await expect(worker.save(request)).rejects.toThrow("候选已冻结");expect((await worker.inspect()).head).toBe(base);await rm(join(worker.cwd,"extra.txt"));
 const saved=await worker.save(request);expect(saved.paths).toEqual(["a.txt"]);expect(await worker.save(request)).toEqual(saved);
});
test("合入CAS成功但checkout失败时重试补现场，不覆盖随后用户变化",async()=>{
 const {root,cwd,repo,base,request}=await fixture(),worker=await repo.createWorktree(join(root,"worker"),"codex/wf-worker",base);await writeFile(join(worker.cwd,"a.txt"),"result\n");const saved=await worker.save(request);
 const input={requestId:crypto.randomUUID(),baseCommit:base,sourceCommit:saved.commit,targetBranch:"main",targetHead:base},original=Bun.spawn;
 const injected=spyOn(Bun,"spawn").mockImplementation((...args:any[])=>{const argv=args[0];if(Array.isArray(argv)&&argv.includes("read-tree")&&argv.includes("-u"))throw Error("fixture checkout unavailable");return (original as any)(...args);});
 try{await expect(repo.mergeSquash(input)).rejects.toThrow("fixture checkout unavailable");}finally{injected.mockRestore();}
 const head=await git(cwd,"rev-parse","HEAD");expect(head).not.toBe(base);await writeFile(join(cwd,"b.txt"),"user\n");await expect(repo.mergeSquash(input)).rejects.toThrow("现场已变化");expect(await Bun.file(join(cwd,"b.txt")).text()).toBe("user\n");await writeFile(join(cwd,"b.txt"),"base\n");
 expect((await repo.mergeSquash(input)).commit).toBe(head);expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("result\n");expect((await repo.inspect()).changedPaths).toEqual([]);
});
test("独立worktree不复制主工作区dirty内容，实际成果保存与同请求重试只创建一个commit", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await writeFile(join(cwd, "a.txt"), "user dirty\n");
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  expect(await Bun.file(join(worker.cwd, "a.txt")).text()).toBe("base\n");
  await writeFile(join(worker.cwd, "a.txt"), "worker result\n");
  const saved = await worker.save(request);
  expect(saved.paths).toEqual(["a.txt"]); expect(saved.commit).not.toBe(base);
  expect(await worker.save(request)).toEqual(saved);
  expect(await git(worker.cwd, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
  expect((await worker.inspect()).changedPaths).toEqual([]);
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("user dirty\n");
});

test("无改动复用HEAD，不生成空commit", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  expect(await worker.save(request)).toEqual({ requestId: request.requestId, commit: base, unchanged: true, paths: [] });
});
test("额外untracked成果自动保存，无需事先列举文件", async () => {
  const { root, repo, base, request } = await fixture(); const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "secret.env"), "secret");
  const saved = await worker.save(request); expect(saved.paths).toEqual(["secret.env"]); expect((await worker.inspect()).head).not.toBe(base); expect(await Bun.file(join(worker.cwd, "secret.env")).text()).toBe("secret");
});
test("禁止主工作区保存、越界路径、符号链接与Git attributes", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await expect(repo.save(request)).rejects.toThrow("非受管分支");
  await git(cwd, "switch", "-c", "codex/wf-user-main");
  await expect(repo.save(request)).rejects.toThrow("主工作区");
  await expect(repo.createWorktree(join(cwd, "worker"), "codex/wf-worker", base)).rejects.toThrow("之外");
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);

  await symlink(join(cwd, "a.txt"), join(worker.cwd, "link"));
  await expect(worker.save({ ...request })).rejects.toThrow("符号链接");
  await rm(join(worker.cwd, "link")); await writeFile(join(worker.cwd, ".gitattributes"), "*.txt filter=evil\n");
  await expect(worker.save({ ...request })).rejects.toThrow("attributes");
});
test("保存后现场变化不能冒充原成果补关联，既有commit保留", async () => {
  const { root, repo, request } = await fixture(); const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", request.baseCommit);
  await writeFile(join(worker.cwd, "a.txt"), "first\n"); const saved = await worker.save(request);
  await writeFile(join(worker.cwd, "a.txt"), "changed\n");
  await expect(worker.save(request)).rejects.toThrow("现场已改变");
  expect((await worker.inspect()).head).toBe(saved.commit);
});
test("hooks及本地filters拒绝打开且不执行外部程序", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  await expect(GitRepository.open(cwd)).rejects.toThrow("hook");
  await rm(join(cwd, ".git", "hooks", "pre-commit")); await git(cwd, "config", "filter.evil.clean", "false");
  await expect(GitRepository.open(cwd)).rejects.toThrow("filters");
});

test("两个独立成果用标准Git显式合并，主分支不变化；冲突现场不允许ready保存", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const a = await repo.createWorktree(join(root, "writer-a"), "codex/wf-a", base);
  const b = await repo.createWorktree(join(root, "writer-b"), "codex/wf-b", base);
  const integration = await repo.createWorktree(join(root, "integration"), "codex/wf-integration", base);
  await writeFile(join(a.cwd, "a.txt"), "a result\n"); await writeFile(join(b.cwd, "b.txt"), "b result\n");
  const first = await a.save(request), second = await b.save({ ...request, requestId: crypto.randomUUID() });
  await git(integration.cwd, "merge", "--no-edit", first.commit);
  await git(integration.cwd, "merge", "--no-edit", second.commit);
  expect(await Bun.file(join(integration.cwd, "a.txt")).text()).toBe("a result\n"); expect(await Bun.file(join(integration.cwd, "b.txt")).text()).toBe("b result\n");
  expect((await integration.inspect()).changedPaths).toEqual([]); expect((await repo.inspect()).head).toBe(base);
  const conflict = await repo.createWorktree(join(root, "conflict-source"), "codex/wf-conflict", base);
  await writeFile(join(conflict.cwd, "a.txt"), "different\n");
  const conflicting = await conflict.save({ ...request, requestId: crypto.randomUUID() });
  await expect(git(integration.cwd, "merge", "--no-edit", conflicting.commit)).rejects.toThrow();
  expect((await integration.inspect()).conflicts).toEqual(["a.txt"]);
  await expect(integration.save({ ...request, startCommit: (await integration.inspect()).head })).rejects.toThrow("merge 冲突");
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
}, 15_000);

test("宿主保存集成成果保留真实多父Git关系，重试不生成第二merge commit", async () => {
  const { root, repo, base, request } = await fixture();
  const source = await repo.createWorktree(join(root, "source"), "codex/wf-source", base);
  const integration = await repo.createWorktree(join(root, "integration"), "codex/wf-merge", base);
  await writeFile(join(source.cwd, "a.txt"), "merged\n"); const saved = await source.save(request);
  await git(integration.cwd, "merge", "--no-commit", "--no-ff", saved.commit);
  const mergeRequest = { ...request, requestId: crypto.randomUUID(), mergeParents: [saved.commit] };
  const merged = await integration.save(mergeRequest);
  expect(await git(integration.cwd, "show", "-s", "--format=%P", merged.commit)).toBe(`${base} ${saved.commit}`);
  expect(await integration.save(mergeRequest)).toEqual(merged);
  const state = await integration.inspect(); expect(await Bun.file(join(state.gitDirectory, "MERGE_HEAD")).exists()).toBe(false);
  expect(await Bun.file(join(integration.cwd, "a.txt")).text()).toBe("merged\n");
  expect((await repo.inspect()).head).toBe(base);
});
