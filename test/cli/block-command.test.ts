import { describe, expect, test } from "bun:test";
import { parseBlockCommand } from "../../src/cli/block-command";
import { parseAnswerCommand, parseContinueCommand } from "../../src/cli/hitl-command";

describe("block / answer / continue 命令", () => {
  test("block 需要 need-help，并接受可选 answer-schema", () => {
    expect(parseBlockCommand(["--need-help", "数据库不可连接", "--answer-schema", '{"type":"object","required":["resolved"]}'])).toEqual({ needHelp: "数据库不可连接", answerSchema: { type: "object", required: ["resolved"] } });
    expect(() => parseBlockCommand(["--need-help", " "])).toThrow("need-help");
    expect(() => parseBlockCommand(["--need-help", "x", "--answer-schema", "[]"])).toThrow("JSON-safe 对象");
  });

  test("answer 与 continue 要求稳定 blockRequestId 和 JSON 对象", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseAnswerCommand([id, "--value", '{"resolved":true}'])).toEqual({ blockRequestId: id, answer: { resolved: true } });
    expect(parseContinueCommand(["--block-request-id", id])).toEqual({ blockRequestId: id });
    expect(() => parseAnswerCommand([id, "--value", "[]"])).toThrow("JSON-safe 对象");
    expect(() => parseContinueCommand(["--block-request-id", "not-id"])).toThrow("continue 用法");
  });
});
