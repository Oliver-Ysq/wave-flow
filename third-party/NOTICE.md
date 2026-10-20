# Vibe Kanban Git algorithm reference

Wave Flow adapts the temporary-index and NUL-delimited path staging approach from BloopAI/vibe-kanban, commit d5cbb5380fa0b32e98ef9b8d987f63decce4be3a, crates/git/src/cli.rs (GitCli::diff_status). Squash target checks are based on crates/git/src/lib.rs (merge_changes).

Upstream: https://github.com/BloopAI/vibe-kanban/tree/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a

License: Apache-2.0, reproduced in vibe-kanban-LICENSE. The upstream root at this revision has no NOTICE file.

Modified by Wave Flow: ported orchestration to TypeScript/Bun; kept owned ACP transport and Control/Journal protocol; added durable Git tree candidates, explicit user target HEAD confirmation, request trailers and compare-and-swap updates. No upstream task branch reset or forced worktree deletion is adopted.

# @pierre/diffs

The Web change-review panel renders unified patches with @pierre/diffs (https://github.com/pierrecomputer/pierre, packages/diffs), installed unmodified from npm.

License: Apache-2.0 (see node_modules/@pierre/diffs/LICENSE.md). The package has no NOTICE file.

# Orca CLI detection and process supervision

Wave Flow adapts the agent-CLI detection and provider-process supervision approach from stablyai/orca, commit 8802b55db7572a1944af5719073ebb95b324d4b7.

Ported:
- src/main/startup/configure-process.ts (installDevParentWatchdog) — parent-exit watchdog control flow.
- src/main/ipc/preflight-command-exec.ts (probeRunnableLocalCommand, PREFLIGHT_LOCAL_PROBE_LIMIT, PREFLIGHT_COMMAND_TIMEOUT_MS) — bounded `--version` candidate probing with a shared deadline and timeout-recovery budget.
- src/shared/system-cli-install-dirs.ts and src/shared/local-agent-install-dir-detection.ts — install-directory fallback when PATH misses a CLI.
- src/main/provider-process/provider-process-supervisor.ts — SIGTERM grace before SIGKILL for provider process groups.

Upstream: https://github.com/stablyai/orca/tree/8802b55db7572a1944af5719073ebb95b324d4b7

License: MIT, reproduced in orca-LICENSE.

Modified by Wave Flow: adapted to a single Bun Engine process with ACP Worker groups; candidate list comes from the login-shell PATH scan; status vocabulary is surfaced to the desktop UI as five user-facing outcomes; no Electron, WSL, Windows or remote-runtime paths are adopted.
