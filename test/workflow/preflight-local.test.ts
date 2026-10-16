import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightLocalWorkflow, validateLocalInput } from "../../src/workflow/preflight-local";
import { loadWorkflowSource } from "../../src/workflow/load-workflow";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-local-preflight-")); roots.push(root);
  const file = join(root, "workflow.ts"); await writeFile(file, source); return { root, file };
}
const source = `export const meta={name:"local-check",description:"静态检查",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{target:{type:"string",minLength:1}},required:["target"],additionalProperties:false}};
export default async function run(args:{target:string}){throw new Error("不能在预检执行");}`;

test("预检转换静态声明但不执行run；输入校验不填默认", async () => {
  const {root,file}=await fixture(source); const result=await preflightLocalWorkflow(file,root);
  expect(result.meta.name).toBe("local-check"); expect(result.source).toBe(source);
  expect(()=>validateLocalInput(result.inputSchema,{})).toThrow("参数无效");
  expect(()=>validateLocalInput(result.inputSchema,{target:"src"})).not.toThrow();
});
test("缺失Schema仅拒绝新Task预检，旧模块冻结加载仍兼容", async () => {
  const legacy=`export const meta={name:"legacy",description:"旧模块",phases:[{title:"检查"}]};export default async function run(args:unknown){return args;}`;
  const {root,file}=await fixture(legacy);
  await expect(preflightLocalWorkflow(file,root)).rejects.toThrow("inputSchema");
  const loaded=await loadWorkflowSource(legacy); await expect(loaded.default({x:1})).resolves.toEqual({x:1});
});
test("项目外、软链接、过大文件与非法Schema零执行拒绝", async () => {
  const a=await fixture(source),b=await fixture(source);
  await expect(preflightLocalWorkflow(b.file,a.root)).rejects.toThrow("项目内");
  const link=join(a.root,"link.ts");await symlink(a.file,link);
  await expect(preflightLocalWorkflow(link,a.root)).rejects.toThrow("软链接");
  await writeFile(a.file," ".repeat(200001)); await expect(preflightLocalWorkflow(a.file,a.root)).rejects.toThrow("200000");
  await writeFile(a.file,source.replace('type:"object",properties', 'type:"array",properties'));
  await expect(preflightLocalWorkflow(a.file,a.root)).rejects.toThrow("对象 Schema");
});
test("语法诊断包含行列，冻结字节加载不读已经编辑的原路径", async () => {
  const {root,file}=await fixture(source); await writeFile(file,"export const meta = ;");
  await expect(preflightLocalWorkflow(file,root)).rejects.toThrow("1:");
  await writeFile(file,source.replace('throw new Error("不能在预检执行")','return args.target'));
  const result=await preflightLocalWorkflow(file,root); await writeFile(file,"坏掉的新版本");
  const loaded=await loadWorkflowSource(result.source,file);
  await expect(loaded.default({target:"原快照"})).resolves.toBe("原快照");
});
