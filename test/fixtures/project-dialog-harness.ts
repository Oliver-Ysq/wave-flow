import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// 独立子进程内替换宿主依赖，避免React/Tauri mock污染其他回归。
const states: unknown[] = [], refs: Array<{ current: any }> = [], effects: Array<() => any> = [];
const jsx = (type: any, props: any) => ({ type, props });
mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx }));
mock.module("react/jsx-dev-runtime", () => ({ jsxDEV: jsx }));
let stateIndex = 0, refIndex = 0, first = true;
mock.module("react", () => ({
  useState: (initial: any) => {
    const index = stateIndex++;
    if (first) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
  },
  useRef: (initial: any) => {
    const index = refIndex++;
    return refs[index] ??= { current: initial };
  },
  useEffect: (effect: () => any) => { if (first) effects.push(effect); },
}));
let chooseCalls = 0, validateCalls = 0, createCalls = 0;
let resolveChoice!: (path: string | null) => void;
let rejectChoice!: (error: Error) => void;
let resolveValidation!: (value: { cwd: string }) => void;
let rejectValidation!: (error: Error) => void;
mock.module("@tauri-apps/plugin-dialog", () => ({ open: () => {
  chooseCalls++; return new Promise((resolve, reject) => { resolveChoice = resolve; rejectChoice = reject; });
} }));
let drag!: (event: any) => void;
let unlistened = 0;
mock.module("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onDragDropEvent: async (handler: any) => { drag = handler; return () => { unlistened++; }; } }) }));
mock.module("../../src-tauri/web/src/api", () => ({ api: {
  validateProjectPath: () => { validateCalls++; return new Promise((resolve, reject) => { resolveValidation = resolve; rejectValidation = reject; }); },
  createProject: async () => { createCalls++; return { project: {} }; },
} }));
Object.assign(globalThis, {
  document: { activeElement: null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
  window: { __TAURI_INTERNALS__: {} }, requestAnimationFrame: () => 0,
});
const { ProjectCreateDialog } = await import("../../src-tauri/web/src/project-create-dialog");
let accepted = 0;
function render(): any {
  stateIndex = refIndex = 0;
  const tree = ProjectCreateDialog({ onClose: () => {}, onCreated: () => { accepted++; } });
  first = false; return tree;
}
function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...elements(tree.props?.children)];
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function button(tree: any, text: string): any { return elements(tree).find(el => el.type === "button" && el.props.children === text); }
function input(tree: any): any { return elements(tree).find(el => el.type === "input"); }
let tree = render();
const cleanups = effects.map(effect => effect()).filter(fn => typeof fn === "function");
input(tree).props.onChange({ target: { value: "/old" } });
tree = render();
const selection = button(tree, "选择文件夹").props.onClick();
await button(tree, "选择文件夹").props.onClick();
button(tree, "创建项目").props.onClick();
assert.equal(chooseCalls, 1); assert.equal(createCalls, 0);
resolveChoice("/chosen"); await tick(); tree = render();
assert.equal(validateCalls, 1);
assert.equal(input(tree).props.value, "");
assert.equal(button(tree, "选择文件夹").props.disabled, true);
assert.equal(button(tree, "创建项目").props.disabled, true);
await button(tree, "选择文件夹").props.onClick();
assert.equal(chooseCalls, 1);
input(tree).props.onChange({ target: { value: "/manual" } });
resolveValidation({ cwd: "/chosen" }); await selection;
tree = render(); assert.equal(input(tree).props.value, "/manual");
assert.equal(button(tree, "创建项目").props.disabled, false);
// 生产Tauri回调：弹窗模态，不按坐标过滤；多路径拒绝，单目录触发核验。
drag({ payload: { type: "drop", paths: ["/a", "/b"] } });
assert.equal(validateCalls, 1);
tree = render();
assert.ok(elements(tree).some(el => el.props?.role === "alert" && el.props.children === "请一次拖入一个文件夹。"));
drag({ payload: { type: "enter", position: { x: 400, y: 300 }, paths: ["/drop"] } });
tree = render();
assert.ok(elements(tree).some(el => el.props?.className === "project-folder-drop hovering"));
drag({ payload: { type: "drop", position: { x: 400, y: 300 }, paths: ["/drop"] } });
assert.equal(validateCalls, 2);
drag({ payload: { type: "drop", position: { x: 400, y: 300 }, paths: ["/duplicate"] } });
assert.equal(validateCalls, 2);
resolveValidation({ cwd: "/canonical-drop" }); await tick();
tree = render(); assert.equal(input(tree).props.value, "/canonical-drop");
assert.equal(createCalls, 0);
drag({ payload: { type: "leave" } });
// 目录核验失败解除loading，不能保留旧目录继续创建。
drag({ payload: { type: "drop", position: { x: 400, y: 300 }, paths: ["/ordinary-file"] } });
rejectValidation(new Error("项目路径必须是文件夹。")); await tick();
tree = render();
assert.equal(input(tree).props.value, "");
assert.equal(button(tree, "选择文件夹").props.disabled, false);
assert.equal(button(tree, "创建项目").props.disabled, true);
assert.ok(elements(tree).some(el => el.props?.role === "alert" && el.props.children === "项目路径必须是文件夹。"));
input(tree).props.onChange({ target: { value: "/manual-after-failure" } }); tree = render();
const failedSelection = button(tree, "选择文件夹").props.onClick();
rejectChoice(new Error("选择器不可用")); await failedSelection; tree = render();
assert.equal(button(tree, "创建项目").props.disabled, false);
assert.ok(elements(tree).some(el => el.props?.role === "alert" && String(el.props.children).includes("选择器不可用")));
// 选择器取消不遗留checking，随后仍可正常打开并核验。
const cancelled = button(tree, "选择文件夹").props.onClick();
resolveChoice(null); await cancelled; tree = render();
assert.equal(button(tree, "创建项目").props.disabled, false);
const late = button(tree, "选择文件夹").props.onClick();
resolveChoice("/late"); await tick();
cleanups.forEach(fn => fn());
resolveValidation({ cwd: "/late" }); await late;
assert.equal(accepted, 0); assert.equal(createCalls, 0);
await tick(); assert.equal(unlistened, 1);
drag({ payload: { type: "drop", position: { x: 400, y: 300 }, paths: ["/after-close"] } });
assert.equal(validateCalls, 4);
console.log("project-dialog async boundaries passed");
