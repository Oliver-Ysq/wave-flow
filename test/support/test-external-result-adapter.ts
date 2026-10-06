import type { CompletionSubmission, ControlServer } from "../../src/control/control-server";

/**
 * 仅供第 5 节测试的外部结果 Adapter。
 *
 * 它刻意只持有 ControlServer 的完成入口，不能访问 Journal、状态机或 Runtime；未来
 * TraeX / HTTP 底座必须满足同一限制，但不在本测试夹具中实现。
 */
export class TestExternalResultAdapter {
  constructor(private readonly control: Pick<ControlServer, "complete">) {}

  /** 外部底座已返回 JSON 结果时唯一允许的提交方式。 */
  async submitCompletion(submission: CompletionSubmission): Promise<void> {
    await this.control.complete(submission);
  }
}
