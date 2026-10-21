# Wave Flow

**Give long tasks a clear path. Let agents play to their strengths.**

Wave Flow is a local desktop app for AI agent workflows. Describe a goal in conversation, review the controller's proposal, then let real Codex / Kimi / DeepSeek Harness / Claude Code agents execute it in stages. Follow progress, answer questions, or stop the work when you need to.

Give long tasks a controlled workflow and each job the right agent. An ever-growing conversation shouldn't have to carry everything from planning to delivery.

[中文](./README.md) | English

## One goal. A coordinated workflow.

For example: “Review this project, have another agent independently verify the findings, and report only evidence-backed issues.”

With Wave Flow, you can:

1. **Review before you run.** Generate and refine workflows through conversation, or start with the built-in read-only code review preset.
2. **Follow work by stage.** A phase → executor view shows the division of work, each agent's state, streamed text, and tool activity.
3. **Step in when needed.** Agents explicitly request human assistance. Your answer supplies information; the original agent confirms continuation. You can also pause or stop execution.
4. **Inspect what happened.** Browse structured deliverables and historical attempts. Recover interrupted work explicitly—never through a silent rerun.

Write workflows use independent Git worktrees and save actual tracked changes and non-ignored untracked files, excluding untracked node_modules. No upfront file allowlist is required. Parallel branches require an explicit integration Worker. Review the final diff and explicitly squash it into a local target branch; no automatic merge or push. Internal checkpoints remain for recovery.

## Why Wave Flow?

### Long tasks need a workflow, not just a remembered plan

Workflows define stages, dependencies, concurrency, and completion conditions, with sequential work, parallel batches, pipelines, and dynamic calls. Explicit execution rules reduce orchestration drift over long runs while leaving agents room to solve the actual problems. Under the hood, TypeScript orchestration balances flexibility with control.

Deliverables must pass schema validation and be durably recorded. “I'm done” is not completion evidence. Controlled execution does not guarantee a correct answer, and execution completion is not goal acceptance.

### Don't bet everything on one agent

Bring Codex, Kimi, DeepSeek Harness and Claude Code into the same Workflow: research independently, cross-review findings, then compare evidence and synthesize the strongest results. Assign work based on the strengths of each CLI, its tools, and its underlying model.

Each Worker uses an independent real ACP session with your selected local CLI and its default model. Multiple CLIs bring complementary model and Harness perspectives, reducing single-path blind spots. CLI assignment is user-controlled; automatic model routing is not provided.

### Refine the plan. Keep execution authority.

Adjust proposals through conversation and retain each revision. Discarding a proposal does not discard the task or conversation. The controller proposes; your confirmation authorizes execution. Follow progress, provide human assistance, pause or stop, and explicitly recover interrupted work.

> Each new Task owns one evolving workflow chain. Revise source, input or CLI configuration after feedback, then explicitly confirm a new Execution on the safely handed-off current scene. Original-version recovery stays within the same Execution; arbitrary node rollback and cross-version automatic replay are not provided.

## A strong fit for

- **Broad, evidence-driven exploration: technical research and large-scale code review.** Let multiple CLIs explore different directions, then verify and compare findings to reduce omissions and bias from a single model or Harness.
- **Structured delivery: requirements → implementation → self-testing → code review.** Put handoffs and verification into the workflow, with distinct development and review roles—not only into a long prompt.
- **Repetitive work with shared standards: dependency upgrades, API migrations, and cross-module cleanup.** Split work by module, handle non-conflicting parts independently, then verify and review consistently. Parallel writes use independent worktrees; conflicts require explicit integration.

## Quick start

Open the desktop app and choose a project, then describe the goal directly, or choose a built-in template or a trusted local TypeScript workflow. Preflight only reads local source; saving a proposal does not execute it. Confirm parameters, CLI choices and any Git authorization on the proposal page to start.

After the execution summary is complete, revise generated proposals through chat, prepare a template parameter version, or edit and recheck a local file. For CLI-only changes, choose “Keep source, prepare a new CLI configuration version.” Write revisions explicitly continue saved workspaces; independent branches require integration. New Executions work anew, and archived Tasks remain read-only.

## Current boundaries

Wave Flow is in early development. Please keep these limits in mind:

- Local workflows are explicitly selected trusted `.ts` extensions inside the project. New local Tasks require a literal `meta.inputSchema` object schema; preflight reads but does not execute. URL downloads, visual workflow editing, remote control and cloud sync are not supported.
- Controllers retain OS write isolation and four narrow tools. Workers use trusted native CLI configuration and permissions, without additional Wave Flow OS file isolation. Worktrees/cwd separate ordinary work, but do not prevent writing other worktrees, shared Git, user files or credentials. Native directories include `~/.codex`, `~/.kimi-code`, `~/.dsh` and `~/.claude`; model tools can also modify configuration and credentials. Task intent is not a security guarantee. Parallel branches may change the same file; explicit integration resolves conflicts.
- DeepSeek Harness and Claude Code have both completed real controller- and Worker-role acceptance and can be set as the default controller. Controllers use their own isolated private home: Claude inherits only auth/model env (user hooks and permissions are excluded); DeepSeek Harness uses the shipped profile skeleton with the user patch cleared, and credentials are referenced by symlink only. DeepSeek Harness needs a provider key under `$DSH_HOME` plus a Node ≥ 24 runtime (on Node ≤ 22 its CLI exits silently with no output). Claude Code acceptance verified harness compatibility (Claude Code 2.1.304 + claude-agent-acp 0.94.0); the model side is decided by your own `~/.claude/settings.json` authentication (acceptance used an Anthropic-compatible endpoint, not an Anthropic model).
- A complete ready source can be reviewed and explicitly squash-merged into a local branch. Target drift and dirty/staged/untracked overwrite risks are rejected; no automatic push. Git evidence does not cover external effects or replace sensitive-content review.
- Revised execution requires complete impact summaries, current-scene supplements and verified writer handoffs. Every actual node in a new Execution works anew; completed results are not cached across Executions. New Tasks use one evolving chain; old multi-card records are not automatically migrated. Archived Tasks are read-only.
- Interrupted execution recovery only reuses strictly matching completed prefixes within the same execution. It does not roll back files or undo external effects.
- Worker stall handling records a diagnostic and interrupts after five minutes without native session events; it does not automatically resend tasks. Human-input waits, user pauses and control operations are exempt. Silence and read-only intent do not establish the absence of side effects.
- Original-version recovery requires a complete execution summary and scene checks. Changed Git evidence requires a separate supplement and renewed confirmation. Unresolved writer handoffs, unsaved changes or inconsistent saved results block recovery without rolling back files; Git fingerprints do not establish external-system state.
- If business execution completed but final Git source persistence failed, explicitly retry the Git handoff without rerunning business Workers. An unverified writer exit still prevents handoff.
- The workbench and execution engine run locally. Model requests still go to the provider used by your chosen CLI; local execution does not mean offline inference or that data never leaves your machine.

Have a suggestion or want to help maintain the project? Contact: <oliver.ysq@gmail.com>

Want agent collaboration to mean more than opening several chat windows? Give Wave Flow a **Star**. Help make complex work easier to follow—and safer to control.
