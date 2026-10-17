# Vibe Kanban Git algorithm reference

Wave Flow adapts the temporary-index and NUL-delimited path staging approach from BloopAI/vibe-kanban, commit d5cbb5380fa0b32e98ef9b8d987f63decce4be3a, crates/git/src/cli.rs (GitCli::diff_status). Squash target checks are based on crates/git/src/lib.rs (merge_changes).

Upstream: https://github.com/BloopAI/vibe-kanban/tree/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a

License: Apache-2.0, reproduced in vibe-kanban-LICENSE. The upstream root at this revision has no NOTICE file.

Modified by Wave Flow: ported orchestration to TypeScript/Bun; kept owned ACP transport and Control/Journal protocol; added durable Git tree candidates, explicit user target HEAD confirmation, request trailers and compare-and-swap updates. No upstream task branch reset or forced worktree deletion is adopted.
