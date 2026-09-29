import type { AgentAdapter, AgentExecutionInput } from "../types";

export class FakeAgentAdapter implements AgentAdapter {
  readonly calls: AgentExecutionInput[] = [];

  constructor(private readonly response: string) {}

  async execute(input: AgentExecutionInput): Promise<{ output: string }> {
    this.calls.push(input);
    return { output: this.response };
  }
}
