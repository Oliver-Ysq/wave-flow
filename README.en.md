# Wave Flow

**Give long tasks a clear path. Let agents play to their strengths.**

Wave Flow is a local desktop app for AI agent workflows. Describe a goal in conversation, review the controller's proposal, then let real Codex / DeepSeek Harness / Claude Code agents execute it in stages (Kimi CLI support is temporarily offline; historical records remain readable). Follow progress, answer questions, or stop the work when you need to.

Give long tasks a controlled workflow and each job the right agent. An ever-growing conversation shouldn't have to carry everything from planning to delivery.

[中文](./README.md) | English

> This project is for learning and research only; it is not a commercial product.

## One goal. A coordinated workflow.

For example: “Review this project, have another agent independently verify the findings, and report only evidence-backed issues.”

With Wave Flow, you can:

1. **Review before you run.** Generate and refine workflows through conversation, or start from a built-in preset: read-only code review, deep research, or deep code review.
2. **Follow work by stage.** A phase → executor view shows the division of work, each agent's state, streamed text, and tool activity.
3. **Step in when needed.** Agents explicitly request human assistance. Your answer supplies information; the original agent confirms continuation. You can also pause or stop execution.
4. **Inspect what happened.** Browse structured deliverables and historical attempts. Recover interrupted work explicitly—never through a silent rerun.

Write workflows use one managed Git worktree: every writing agent in an execution shares the same directory, and changes stay in that worktree as ordinary uncommitted files. No upfront file allowlist is required. The host neither detects nor merges write conflicts—a later write to the same file overwrites an earlier one—so tasks should be partitioned by module/file. When the execution completes, the host creates no commit, stores no snapshot, writes nothing into your main working tree, and moves no branch: the worktree's current contents are the result. Reviewing, modifying, committing, or cleaning it up is the user's responsibility; cleaning the worktree also deletes its uncommitted contents.

## Why Wave Flow?

### Long tasks need a workflow, not just a remembered plan

Workflows define stages, dependencies, concurrency, and completion conditions, with sequential work, parallel batches, pipelines, and dynamic calls. Explicit execution rules reduce orchestration drift over long runs while leaving agents room to solve the actual problems. Under the hood, TypeScript orchestration balances flexibility with control.

Deliverables must pass schema validation and be durably recorded. “I'm done” is not completion evidence. Controlled execution does not guarantee a correct answer, and execution completion is not goal acceptance.

### Don't bet everything on one agent

Bring Codex, DeepSeek Harness and Claude Code into the same Workflow: research independently, cross-review findings, then compare evidence and synthesize the strongest results. Assign work based on the strengths of each CLI, its tools, and its underlying model.

Each Worker uses an independent real ACP session with your selected local CLI and its default model. Multiple CLIs bring complementary model and Harness perspectives, reducing single-path blind spots. CLI assignment is user-controlled; automatic model routing is not provided.

### One skill library, injected at session start

Keep your own skills under `~/.wave-flow/skills/<name>/SKILL.md`. Wave Flow projects them into every controller and Worker session with symlinks, without writing to or overriding native CLI directories, so standalone codex/claude/dsh usage is unaffected. Settings → Skills can discover and import from each local CLI skill directory, or upload one `skill.zip`; imported skills are merged into the controller slash menu (`$name` for Codex, `/name` for Claude/DSH) and become available to a new or idle-restarted controller session; imports validate SKILL.md, frontmatter, symlinks, name conflicts and ZIP paths/size, copy rather than overwrite, and never execute skill code. An empty library changes nothing; when the library is non-empty and the selected CLI has no verified injection capability, the session fails closed instead of silently skipping.

### Refine the plan. Keep execution authority.

Adjust proposals through conversation and retain each revision. Discarding a proposal does not discard the task or conversation. The controller proposes; your confirmation authorizes execution. Follow progress, provide human assistance, pause or stop, and explicitly recover interrupted work.

> Each new Task owns one evolving workflow chain. Revise source, input or CLI configuration after feedback, then explicitly confirm a new Execution on the shared worktree handed over from the latest write execution. Original-version recovery stays within the same Execution; arbitrary node rollback and cross-version automatic replay are not provided.

### Explicit failure boundaries for execution and evidence

Stopping or exiting revokes startup permission for queued and initializing nodes, so Workers do not start after the Run has stopped. A failed Journal append rejects subsequent writes and preserves the original error, while shutdown still makes a best effort to signal real Workers. Writer processes record a durable spawn intent before launch; if a crash leaves their state unverifiable, resume fails closed instead of risking duplicate writers.

Large evidence path lists are collected as complete streams rather than truncated evidence, and the changes viewer supports pagination. Image attachments are limited to 10MB each and are checked for identity before reading and actual byte size afterward. Execution details poll with a single in-flight request, preventing large evidence responses from starving the page.

## Download and installation

Current version: `v0.2.6`, supporting macOS 12+ / Apple Silicon. Install from a terminal:

```sh
curl -fsSL https://oliver-ysq.github.io/wave-flow/install.sh | sh
```

You can also download `Wave.Flow_0.2.6_aarch64.dmg` from [Releases](https://github.com/Oliver-Ysq/wave-flow/releases), or build from source:

```sh
bun install
bun run desktop:dev   # development mode
bun run desktop:build # release package
```

Build output is under `src-tauri/target/release/bundle/`. Development machines without a certificate use ad-hoc signing. Distribution still requires a Developer ID plus validation of hardened runtime, Bun JIT entitlements and notarization. Intel builds need an additional target and separate validation.

## A strong fit for

- **Broad, evidence-driven exploration: technical research and large-scale code review.** Let multiple CLIs explore different directions, then verify and compare findings to reduce omissions and bias from a single model or Harness.
- **Structured delivery: requirements → implementation → self-testing → code review.** Put handoffs and verification into the workflow, with distinct development and review roles—not only into a long prompt.
- **Repetitive work with shared standards: dependency upgrades, API migrations, and cross-module cleanup.** Split work by module, handle parts independently, then verify and review consistently. Parallel writes share one worktree and must be partitioned by module/file; directory separation is not a security boundary.

## Quick start

Open the desktop app and choose a project, then describe the goal directly, or choose a built-in template or a trusted local TypeScript workflow. Preflight only reads local source; saving a proposal does not execute it. Confirm parameters, CLI choices and any Git authorization on the proposal page to start.

Built-in presets:

- **Code review**: two sequential read-only workers—review first, then an independent worker re-checks the evidence and drops unsupported claims.
- **Deep research**: a planning agent turns the topic into parallel research questions and waits for your confirmation; research then runs in parallel, and every claim must carry an excerpt plus source URL that an independent verifier re-opens and checks. Contradictions and single-source claims are cross-checked; `deep` mode runs a second targeted round for evidence gaps; a red-team pass and revision produce a report with citations and confidence levels. It needs a CLI whose workers can search and browse.
- **Deep code review**: it first maps the change surface, module structure and repository review conventions, then six specialist reviewers (correctness, security, concurrency and state, error handling and resources, interface and data compatibility, intent and tests) review in parallel. Every finding needs file, line range, trigger and confidence, and an independent verifier re-opens the source to confirm it and drop false positives; findings are then deduplicated, ranked and cross-checked, and blind spots are reported. Read-only throughout: it never modifies files and never runs builds or tests.

Type `/` in the composer to open the command menu: `/wave-flow` asks the controller to generate a Workflow proposal for the current goal; skills are advertised by the current controller CLI through ACP. A selected command becomes a bold accent-colored icon block without the leading slash or background; multiple commands can be inserted, and Backspace deletes a block as a whole. Selecting only fills the composer without sending. `/compact` is not provided.

With no project yet, the new-task page offers a “New project” primary action and keeps the composer locked; choose a project to reveal sources and input. The latest unreviewed pending proposal appears above the composer as “proposal N pending confirmation” and opens the plan directly; the task toolbar groups current status, primary action and history. The latest execution is shown as one card in the conversation, while older executions keep a single-line history entry—no duplicate “started/finished” rows.

After the execution summary is complete, revise generated proposals through chat, prepare a template parameter version, or edit and recheck a local file. For CLI-only changes, choose “Keep source, prepare a new CLI configuration version.” Write revisions automatically continue the shared worktree of the latest write execution in the same Task and freeze the handover HEAD; the scene is re-checked before the new Execution starts, and old results are never reused automatically. New Executions work anew, and archived Tasks remain read-only.

## Current boundaries

Wave Flow is in early development. Please keep these limits in mind:

- Local workflows are explicitly selected trusted `.ts` extensions inside the project. New local Tasks require a literal `meta.inputSchema` object schema; preflight reads but does not execute. URL downloads, visual workflow editing, remote control and cloud sync are not supported.
- Perception mode is on by default for the controller: it uses your native CLI configuration and tools (skills/MCP/CLI) to read information, and the OS only denies writes to the current project and the Engine state directory, so project files are not modified by controller sessions; changing the project still requires proposing a Workflow and your confirmation. You can turn perception mode off in settings; the controller then returns to a private isolated home, full write isolation and the four narrow tools. Project protection covers only the current project, not other projects, other Git repositories or your home directory; network and external-system side effects are not proven by the file policy, and the controller can still read credentials and call logged-in tools. Perception mode prohibits creating new hard links; pre-existing hard-link aliases outside the project are not enumerable by the path sandbox and must be cleaned up by the user. Workers use trusted native CLI configuration and permissions without additional Wave Flow OS file isolation. worktree/cwd separate ordinary work, but do not prevent Workers from writing other directories, other worktrees, shared Git or credentials; task intent is not a security guarantee. One execution creates one shared managed worktree and all writing nodes share the same directory; the host does no conflict detection or merging, and a later write to the same file overwrites an earlier one, so tasks should be partitioned by module/file. Git diff does not prove effects outside the working tree and does not replace sensitive-content review.
- After the execution completes, the host stores no snapshot and creates no commit: the result is simply the managed worktree's current files and is never written into your main working tree. No branch is moved and nothing is pushed. Reviewing, modifying, committing or cleaning it up is up to you; cleaning the worktree deletes its uncommitted contents. Native CLIs still use `~/.codex`, `~/.dsh` and `~/.claude`; model tools can also modify configuration and credentials.
- Kimi CLI support is temporarily offline: detection, validation, default-controller and Worker assignment entries are removed, while historical Journal/Execution records stay read-only and readable. Re-enabling requires reconnecting and re-validating the CLI; old records are never rewritten. The managed skill library only projects skill files into sessions; it does not provide binaries declared in `metadata.requires.bins`, login state, network or MCP. Settings performs a read-only PATH diagnostic for `requires.bins` and reports missing entries, but never installs dependencies or modifies PATH. Codex's extra root also expands its sandbox write roots, so the projection lives only inside Wave Flow session scratch. Workers can modify the library under the trusted-native-CLI model, which can influence later controller sessions; this is not a new OS isolation boundary. Library changes invalidate reuse of old completed nodes during Replay.
- DeepSeek Harness and Claude Code have both completed real controller- and Worker-role acceptance and can be set as the default controller. With the default perception mode the controller uses your native configuration directly (skills/MCP/CLI/login state available); when perception mode is off, controllers use their own isolated private home: Claude inherits only auth/model env (user hooks and permissions are excluded); DeepSeek Harness uses the shipped profile skeleton with the user patch cleared, and credentials are referenced by symlink only. DeepSeek Harness needs a provider key under `$DSH_HOME` plus a Node ≥ 24 runtime (on Node ≤ 22 its CLI exits silently with no output). Claude Code acceptance verified harness compatibility (Claude Code 2.1.304 + claude-agent-acp 0.94.0); the model side is decided by your own `~/.claude/settings.json` authentication (acceptance used an Anthropic-compatible endpoint, not an Anthropic model).
- Revised execution requires complete impact summaries, current-scene supplements and verified writer handoffs. Every actual node in a new Execution works anew; completed results are not cached across Executions. New Tasks use one evolving chain; old multi-card records are not automatically migrated. Archived Tasks are read-only.
- Interrupted execution recovery only reuses strictly matching completed prefixes within the same execution. It does not roll back files or undo external effects.
- When a Worker's native session shows no substantive progress (text/tool/plan events) for five minutes, the executor records a single stall diagnostic hint; it does not interrupt, cancel, kill the process or resend tasks. Human-input waits, user pauses and control operations are exempt, and the only exit is an explicit user stop. Silence and read-only intent do not establish the absence of side effects.
- Original-version recovery requires a complete execution summary and scene checks. Changed Git evidence requires a separate supplement and renewed confirmation. Unresolved writer handoffs, unsaved changes or inconsistent saved results block recovery without rolling back files; Git fingerprints do not establish external-system state.
- If business execution completed but final Git evidence collection failed, explicitly retry the host finalization (the Workflow is not rerun and business Workers are not re-executed). The result stays in the managed worktree. An unverified writer exit still prevents handoff.
- The workbench and execution engine run locally. Model requests still go to the provider used by your chosen CLI; local execution does not mean offline inference or that data never leaves your machine.

Have a suggestion or want to help maintain the project? Contact: <oliver.ysq@gmail.com>

Want agent collaboration to mean more than opening several chat windows? Give Wave Flow a **Star**. Help make complex work easier to follow—and safer to control.
