# Wave Flow

A local, single-user desktop workflow application for AI coding agents.

[中文](./README.md) | English

## Available today

- Organize persistent tasks by local project; discuss goals and workflow proposals with a main controller.
- Use generated workflows or the built-in read-only code review and independent verification preset.
- Let the controller collect missing parameters, or edit compact inputs directly; optional fields are folded.
- Inspect Phase → Worker designs and select verified Codex or Kimi CLI inline. Workers use the CLI's own default model.
- “Confirm and run” uses the current parameter draft. “Save for later” persists an unapproved candidate without starting Workers.
- Keep immutable revisions. Stale revisions, turns and responses cannot overwrite the current candidate; retries of the same confirmation do not create duplicate executions.
- Inspect progress, structured results and historical attempts; handle explicit human assistance, pause, recover, stop and user-authorized interrupted execution recovery.
- Bind each Worker to an independent real ACP session. Business completion requires private control MCP validation and durable Journal evidence.

## Quick start

Development requires [Bun](https://bun.sh/), Rust/Tauri build tools, and at least one installed Codex or Kimi CLI.

```bash
bun install
bun run desktop:build
# Open src-tauri/target/release/bundle/macos/Wave Flow.app
```

Add a local project, verify a CLI in the execution-base settings and select the controller. Create a task, choose a preset and either ask the controller to prepare parameters or fill and save them directly. Review parameters and inline CLI choices before confirming execution.

Desktop owns a dedicated Execution Engine and communicates through private IPC. There is no global daemon or HTTP port. Closing the window hides the workbench without stopping work; explicitly quitting durably cancels active execution and releases sessions. Reopening never automatically reruns work.

## Boundaries

- Current development bundles target macOS Apple Silicon. The local workflow-file task entry is not open; no standalone control CLI or browser HTTP workbench is provided.
- The preset catalog currently contains one read-only review template. URL workflows are not downloaded. Complex parameter objects are preserved and adjusted through controller conversation.
- Workflow designs illustrate source declarations, not a visual editor or guaranteed dynamic call count. Runtime records are authoritative.
- The controller cannot approve, execute workflows or control Workers. User confirmation grants execution authority. Ordinary parameters use conversation; business decisions retain explicit waiting and answer forms.
- Answers alone do not resume Workers. ACP turn endings, natural-language completion and process exit are not completion evidence.
- Engine restarts never claim old ACP sessions or resend prompts. Explicit recovery only reuses strictly matching completed prefixes within the same execution. Journals do not roll back files or external effects.
- Project directories are shared; parallel writes require provably disjoint paths. Conflicting work runs sequentially. Only read-only and workspace-write modes are supported.
- After the previous execution is terminal and the controller is idle, users may explicitly prepare another workflow. Previous results are not automatically injected. Automatic summaries, TraeX, Retry and worktree isolation are not implemented.
- Model question quality is not deterministic. Unverified or changed CLI identities fail closed. Real Chinese IME candidate submission and full-App startup/input latency need dedicated validation. Markdown formatting loads on demand; readable text is preserved while loading or after failure, with an explicit retry.

## Development checks

```bash
bun run check
bun test --timeout 30000
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Use `bun run desktop:dev` for development. Vite is development-only; release UI communicates with the private Engine without browser fallback.
