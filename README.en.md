# Wave Flow

**Give long tasks a clear path. Let agents play to their strengths.**

Wave Flow is a local desktop app for AI agent workflows. Describe a goal in conversation, review the controller's proposal, then let real Codex / Kimi agents execute it in stages. Follow progress, answer questions, or stop the work when you need to.

Give long tasks a controlled workflow and each job the right agent. An ever-growing conversation shouldn't have to carry everything from planning to delivery.

[中文](./README.md) | English

## One goal. A coordinated workflow.

For example: “Review this project, have another agent independently verify the findings, and report only evidence-backed issues.”

With Wave Flow, you can:

1. **Review before you run.** Generate and refine workflows through conversation, or start with the built-in read-only code review preset.
2. **Follow work by stage.** A Phase → Worker view shows the division of work, each agent's state, streamed text, and tool activity.
3. **Step in when needed.** Agents explicitly request human assistance. Your answer supplies information; the original agent confirms continuation. You can also pause or stop execution.
4. **Inspect what happened.** Browse structured deliverables and historical attempts. Recover interrupted work explicitly—never through a silent rerun.

Write workflows use independent Git worktrees and save actual tracked changes and non-ignored untracked files, excluding untracked node_modules. No upfront file allowlist is required. Parallel branches require an explicit integration Worker. Review the final diff and explicitly squash it into a local target branch; no automatic merge or push. Internal checkpoints remain for recovery.

## Why Wave Flow?

### Long tasks need a workflow, not just a remembered plan

Workflows define stages, dependencies, concurrency, and completion conditions, with sequential work, parallel batches, pipelines, and dynamic calls. Explicit execution rules reduce orchestration drift over long runs while leaving agents room to solve the actual problems. Under the hood, TypeScript orchestration balances flexibility with control.

Deliverables must pass schema validation and be durably recorded. “I'm done” is not completion evidence. Controlled execution does not guarantee a correct answer, and execution completion is not goal acceptance.

### Don't bet everything on one agent

Bring Codex and Kimi into the same Workflow: research independently, cross-review findings, then compare evidence and synthesize the strongest results. Assign work based on the strengths of each CLI, its tools, and its underlying model.

Each Worker uses an independent real ACP session with your selected local CLI and its default model. Multiple CLIs bring complementary model and Harness perspectives, reducing single-path blind spots. CLI assignment is user-controlled; automatic model routing is not provided.

### Refine the plan. Keep execution authority.

Adjust proposals through conversation and retain each revision. Discarding a proposal does not discard the task or conversation. The controller proposes; your confirmation authorizes execution. Follow progress, provide human assistance, pause or stop, and explicitly recover interrupted work.

> Pre-execution proposal changes and original-version recovery are available. Post-execution workflow revision and continuation are not publicly enabled. Arbitrary node rollback and automatic cross-version replay are not provided.

## A strong fit for

- **Broad, evidence-driven exploration: technical research and large-scale code review.** Let multiple CLIs explore different directions, then verify and compare findings to reduce omissions and bias from a single model or Harness.
- **Structured delivery: requirements → implementation → self-testing → code review.** Put handoffs and verification into the workflow, with distinct development and review roles—not only into a long prompt.
- **Repetitive work with shared standards: dependency upgrades, API migrations, and cross-module cleanup.** Split work by module, handle non-conflicting parts independently, then verify and review consistently. Parallel writes remain subject to the path constraints below.

## Quick start

Coming soon.

## Current boundaries

Wave Flow is in early development. Please keep these limits in mind:

- The local `.ts` workflow task entry is not publicly enabled. URL workflow downloads, visual workflow editing, remote control, and cloud sync are not supported.
- Controllers retain OS write isolation and four narrow tools. Workers use trusted native CLI configuration and permissions, without additional Wave Flow OS file isolation. Worktrees/cwd separate ordinary work, but do not prevent writing other worktrees, shared Git, user files or credentials. Native directories include `~/.codex` and `~/.kimi-code`; model tools can also modify configuration and credentials. Task intent is not a security guarantee. Parallel branches may change the same file; explicit integration resolves conflicts.
- A complete ready source can be reviewed and explicitly squash-merged into a local branch. Target drift and dirty/staged/untracked overwrite risks are rejected; no automatic push. Git evidence does not cover external effects or replace sensitive-content review.
- Automatic impact summaries are available. Continuing from an edited workflow across versions is not publicly enabled.
- Interrupted execution recovery only reuses strictly matching completed prefixes within the same execution. It does not roll back files or undo external effects.
- The workbench and execution engine run locally. Model requests still go to the provider used by your chosen CLI; local execution does not mean offline inference or that data never leaves your machine.

Have a suggestion or want to help maintain the project? Contact: <oliver.ysq@gmail.com>

Want agent collaboration to mean more than opening several chat windows? Give Wave Flow a **Star**. Help make complex work easier to follow—and safer to control.
