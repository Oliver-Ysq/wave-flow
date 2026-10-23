import { describe, expect, test } from "bun:test";
import { cliUnavailableReason, isCliSelectable, TEMPORARILY_UNAVAILABLE_CLIS } from "../../src/shared/cli-availability";

describe("CLI 可用性开关", () => {
  test("kimi 暂时不可选，其余 CLI 可选", () => {
    expect([...TEMPORARILY_UNAVAILABLE_CLIS]).toEqual(["kimi"]);
    expect(isCliSelectable("kimi")).toBe(false);
    expect(isCliSelectable("codex")).toBe(true);
    expect(isCliSelectable("claude")).toBe(true);
    expect(isCliSelectable("dsh")).toBe(true);
  });

  test("不可用原因可直接展示且不含内部实现细节", () => {
    const reason = cliUnavailableReason("kimi");
    expect(reason).toContain("Kimi CLI");
    expect(reason).toContain("暂时下线");
    expect(reason).not.toContain("capability");
    expect(reason).not.toContain("FIFO");
    expect(cliUnavailableReason("codex")).toBeNull();
  });
});
