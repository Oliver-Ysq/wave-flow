# Wave Flow

**Give long tasks a clear path. Let agents play to their strengths.**

Wave Flow is a local desktop app for AI agent workflows. Describe a goal in conversation and let the controller propose a plan; once you confirm, real Codex / DeepSeek Harness / Claude Code agents execute it in stages (Kimi CLI support is temporarily offline; historical records remain readable). You can follow progress, answer questions, or stop the work at any time.

Give long tasks a controlled workflow and each job the right agent. An ever-growing conversation shouldn't have to carry everything from planning to delivery.

[中文](./README.md) | English

> This project is for learning and research only; it is not a commercial product.

## One goal. A coordinated workflow.

For example: “Review this project, have another agent independently verify the findings, and report only evidence-backed issues.”

With Wave Flow, you can:

1. **Review before you run.** Generate and refine workflows through conversation, or start from a built-in preset: read-only code review, deep research, or deep code review.
2. **Follow work by stage.** A phase → executor view shows the division of work, each agent's state, streamed text, and tool activity.
3. **Step in when needed.** Agents explicitly request human assistance; your answer supplies information, and the original agent confirms continuation. You can also pause or stop execution.
4. **Inspect what happened.** Browse structured deliverables and historical attempts; recover interrupted work explicitly, never through a silent rerun.

Write workflows run in a separate managed Git worktree, and results stay there as uncommitted changes. The host does not commit, write back to your main working tree, or move branches; you decide how to inspect, modify, commit, or clean up. Parallel writes must be partitioned by module or file, since the host neither detects nor merges conflicts.

## Why Wave Flow?

### Long tasks need a workflow, not just a remembered plan

Workflows define stages, dependencies, concurrency, and completion conditions, with sequential work, parallel batches, pipelines, and dynamic calls. Explicit execution rules reduce orchestration drift over long runs while leaving agents room to solve the actual problems. Under the hood, TypeScript orchestration balances flexibility with control.

Deliverables must pass schema validation and be durably recorded. “I'm done” is not completion evidence.

### Don't bet everything on one agent

Bring Codex, DeepSeek Harness and Claude Code into the same Workflow: research independently, cross-review findings, then compare evidence and synthesize the strongest results. Each Worker uses an independent real ACP session with your selected local CLI and its default model; multiple CLIs reduce single-path blind spots.

### One skill library, injected at session start

Keep your own skills under `~/.wave-flow/skills/<name>/SKILL.md`. Wave Flow projects them into controller and Worker sessions with symlinks, without writing to native CLI directories, so standalone codex/claude/dsh usage is unaffected. Settings → Skills can discover and import from each local CLI skill directory, or upload one `skill.zip`. An empty library changes nothing.

### Refine the plan. Keep execution authority.

Adjust proposals through conversation and retain each revision; discarding a proposal does not discard the task or conversation. The controller proposes, and your confirmation authorizes execution. The controller reads information using your native CLI configuration but cannot modify project files directly; project changes still require a Workflow and your confirmation. Follow progress, provide human assistance, pause or stop, and explicitly recover interrupted work.

> Each new Task owns one evolving workflow chain. Revise source, input or CLI configuration after feedback, then confirm a new Execution on the handed-over worktree. Original-version recovery stays within the same Execution; arbitrary node rollback is not provided.

## Download and installation

Current version: `v0.2.11`, supporting macOS 12+ / Apple Silicon.

Prerequisites (Wave Flow neither bundles nor installs these):

- **At least one supported local CLI** — Codex, Claude Code or DeepSeek Harness, already installed and signed in with your own account. The settings page only scans and verifies existing installs; model requests go to the provider used by your chosen CLI.
- **System Git** — managed write executions, workspace verification and worktree hand-off depend on it. On macOS it comes with Xcode Command Line Tools.
- **System `unzip`** — only used to import a single `skill.zip`; bundled with macOS.
- **DeepSeek Harness** needs a provider key under `$DSH_HOME` and a Node ≥ 24 runtime; **Claude Code** model and authentication come from your `~/.claude/settings.json`.
- Optional: `ripgrep` (`rg`) only affects the controller's read-only full-text search.

Native CLIs still use `~/.codex`, `~/.dsh` and `~/.claude`; model tools can also modify their configuration and credentials.

Install from a terminal:

```sh
curl -fsSL https://oliver-ysq.github.io/wave-flow/install.sh | sh
```

You can also download `Wave.Flow_0.2.11_aarch64.dmg` from [Releases](https://github.com/Oliver-Ysq/wave-flow/releases), or build from source:

```sh
bun install
bun run desktop:dev   # development mode
bun run desktop:build # release package
```

Build output is under `src-tauri/target/release/bundle/`. Distribution requires a Developer ID plus validation of hardened runtime, Bun JIT entitlements and notarization.

## A strong fit for

- **Broad, evidence-driven exploration: technical research and large-scale code review.** Let multiple CLIs explore different directions, then verify and compare findings to reduce omissions and bias from a single model.
- **Structured delivery: requirements → implementation → self-testing → code review.** Put handoffs and verification into the workflow, with distinct development and review roles.
- **Repetitive work with shared standards: dependency upgrades, API migrations, and cross-module cleanup.** Split work by module, handle parts independently, then verify and review consistently.

## Quick start

Open the desktop app and choose a project, then describe the goal directly, or choose a built-in template or a trusted local TypeScript workflow. Preflight only reads local source; saving a proposal does not execute it. Confirm parameters, CLI choices and any Git authorization on the proposal page to start.

Built-in presets:

- **Code review**: two sequential read-only workers—review first, then an independent worker re-checks the evidence and drops unsupported claims.
- **Deep research**: a planning agent turns the topic into research questions and waits for your confirmation; research then runs in parallel, and every claim must carry an excerpt plus source URL that an independent verifier re-opens and checks. A red-team pass and revision produce a report with citations and confidence levels. It needs a CLI whose workers can search and browse.
- **Deep code review**: it first maps the change surface, module structure and repository review conventions, then six specialist reviewers review in parallel; an independent verifier re-opens the source to confirm every finding and drop false positives, then findings are deduplicated and ranked. Read-only throughout; it never runs builds or tests.

Type `/` in the composer to open the command menu: `/wave-flow` asks the controller to generate a Workflow proposal for the current goal. The proposal is a standard ESM author module that you can approve for execution, or save and adopt as a project-local `.ts` source.

After execution, review the summary. To adjust, revise the generated proposal, prepare a new template parameter version, or edit a local file and re-run preflight. Archived Tasks are read-only.

## Feedback

Have a suggestion or want to help maintain the project? Contact: <oliver.ysq@gmail.com>

Want agent collaboration to mean more than opening several chat windows? Give Wave Flow a **Star**. Help make complex work easier to follow—and safer to control.
