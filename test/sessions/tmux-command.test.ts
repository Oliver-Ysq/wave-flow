import { describe, expect, test } from "bun:test";
import { TmuxCommandClient, type TmuxCommandRunner } from "../../src/sessions/backends/tmux-command";

describe("TmuxCommandClient", () => {
  test("所有命令显式携带私有 socket，liveness 保持三态", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = { run: async (args) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    await expect(new TmuxCommandClient("/private/socket", runner).liveness("wf-test")).resolves.toBe("exists");
    expect(calls[0]).toEqual(["-S", "/private/socket", "has-session", "-t", "wf-test"]);
    const missing: TmuxCommandRunner = { run: async () => ({ exitCode: 1, stdout: "", stderr: "can't find session: wf-test" }) };
    await expect(new TmuxCommandClient("/private/socket", missing).liveness("wf-test")).resolves.toBe("missing");
    const failedControlPlane: TmuxCommandRunner = { run: async () => ({ exitCode: 1, stdout: "", stderr: "connection refused" }) };
    await expect(new TmuxCommandClient("/private/socket", failedControlPlane).liveness("wf-test")).resolves.toBe("unknown");
    const unknown: TmuxCommandRunner = { run: async () => { throw new Error("timeout"); } };
    await expect(new TmuxCommandClient("/private/socket", unknown).liveness("wf-test")).resolves.toBe("unknown");
  });

  test("文本经 buffer 发送，不拼入 shell argv", async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const runner: TmuxCommandRunner = { run: async (args, _timeout, stdin) => { calls.push({ args: [...args], stdin }); return { exitCode: 0, stdout: "", stderr: "" }; } };
    await new TmuxCommandClient("/private/socket", runner).pasteText("wf-test", "wf-buffer", "text; $(unsafe)");
    expect(calls[0].stdin).toBe("text; $(unsafe)");
    expect(calls[0].args).not.toContain("text; $(unsafe)");
    expect(calls[1].args).toContain("paste-buffer");
    expect(calls[1].args).toContain("-p");
  });

  test("提交键只能以受控 Enter 经私有 socket 发送", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = { run: async (args) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    await new TmuxCommandClient("/private/socket", runner).sendSpecialKey("wf-test", "Enter");
    expect(calls).toEqual([["-S", "/private/socket", "send-keys", "-t", "wf-test", "Enter"]]);
  });

  test("旧 tmux 不支持 resize-window 时回退到私有单 pane 的 resize-pane", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = { run: async (args) => {
      calls.push([...args]);
      if (args.includes("resize-window")) return { exitCode: 1, stdout: "", stderr: "unknown command: resize-window" };
      if (args.includes("display-message")) return { exitCode: 0, stdout: "120 40\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    } };
    await expect(new TmuxCommandClient("/private/socket", runner).resize("wf-test", 120, 40)).resolves.toEqual({ cols: 120, rows: 40 });
    expect(calls.map((args) => args[2])).toEqual(["resize-window", "resize-pane", "display-message"]);
  });
});
