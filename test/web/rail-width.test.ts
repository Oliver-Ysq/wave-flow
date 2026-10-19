import { expect, test } from "bun:test";
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  clampRailWidth,
  loadRailWidth,
  persistRailWidth,
  railWidthFromDrag,
} from "../../src-tauri/web/src/rail-width";

test("侧栏宽度钳制：越界收敛到最小/最大，非有限数回退默认", () => {
  expect(clampRailWidth(0)).toBe(RAIL_WIDTH_MIN);
  expect(clampRailWidth(-50)).toBe(RAIL_WIDTH_MIN);
  expect(clampRailWidth(99_999)).toBe(RAIL_WIDTH_MAX);
  expect(clampRailWidth(288.4)).toBe(288);
  expect(clampRailWidth(Number.NaN)).toBe(RAIL_WIDTH_DEFAULT);
  expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(RAIL_WIDTH_DEFAULT);
});

test("贴左侧栏右边框拖动：宽度与指针位移一对一且受约束", () => {
  expect(railWidthFromDrag(260, 260, 360)).toBe(360);
  expect(railWidthFromDrag(260, 260, 160)).toBe(RAIL_WIDTH_MIN);
  expect(railWidthFromDrag(260, 0, 5000)).toBe(RAIL_WIDTH_MAX);
  expect(railWidthFromDrag(300, 300, 100)).toBe(RAIL_WIDTH_MIN);
});

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

test("耐久保存：缺失、损坏与越界值一律回退默认，合法值原样恢复", () => {
  expect(loadRailWidth(fakeStorage())).toBe(RAIL_WIDTH_DEFAULT);
  expect(loadRailWidth(fakeStorage({ "wave-flow.rail-width.v1": "garbage" }))).toBe(RAIL_WIDTH_DEFAULT);
  expect(loadRailWidth(fakeStorage({ "wave-flow.rail-width.v1": "10" }))).toBe(RAIL_WIDTH_MIN);
  expect(loadRailWidth(fakeStorage({ "wave-flow.rail-width.v1": "312" }))).toBe(312);
});

test("保存后读取一致；只读存储不阻断拖动", () => {
  const storage = fakeStorage();
  persistRailWidth(333, storage);
  expect(loadRailWidth(storage)).toBe(333);
  persistRailWidth(99_999, storage);
  expect(loadRailWidth(storage)).toBe(RAIL_WIDTH_MAX);
  const readonly = {
    getItem: () => null,
    setItem: () => { throw new Error("denied"); },
  };
  expect(() => persistRailWidth(300, readonly)).not.toThrow();
});
