# Wave Flow

> A dynamic workflow for AI coding agents — keeping long-running work
> controllable, visible, and recoverable through CLI and locally managed sessions.

*Inspired by Claude Code Dynamic Workflows.*

[中文](./README.md) | English

## Available today

- Author reusable dynamic workflows in TypeScript; agent nodes advance from actual workflow calls at runtime.
- Host one real, long-lived, interactive Codex CLI session for each agent node.
- Create a Run with `wave-flow run`; receive its Run ID after safe initial-task delivery, then watch live state changes in the current terminal.
- Read a Run again with `wave-flow inspect <run-id>`.
- Let agents report validated structured completion results through `wave-flow complete`, and request human help through `block / answer / continue`; terminal text is never completion evidence.
- After a daemon restart, a still-verifiable managed session can continue `answer / block / continue / complete` control operations without resending the task or creating a new agent.
- `wave-flow resume <run-id>` is user-authorized call-level recovery: it strictly reuses a matching completed prefix and creates a new attempt from the first unverifiable node.
- Persist Runs, events, session coordinates, and results in the local daemon, which manages sessions in a private tmux socket.

## Current boundaries

- Only `agent(..., { cli: "codex" })` is supported today.
- Wave Flow is for one local user; its daemon runs locally.
- Local Web, Web Terminal, TraeX, Retry, and Herdr / PTY backends are not implemented.
- By default, initial-task delivery is confirmed by the Codex App Server `turn/start` ACK. tmux is a viewer for the interactive session; neither delivery nor completion is inferred from terminal text.

## Quick start

Requirements: [Bun](https://bun.sh/), the Codex CLI, and tmux.

Link the package locally:

```bash
bun link
```

Create a Workflow. `meta.phases` declares its phases; call `phase()` with one of them before `agent()`:

```ts
import { agent, phase } from "wave-flow";

export const meta = {
  name: "local-check",
  description: "Verify the local CLI path.",
  phases: [{ title: "Check" }],
};

export default async function run(args: { target: string }) {
  phase("Check");
  return agent("Check the target.", {
    id: "check-target",
    cli: "codex",
    input: { target: args.target },
  });
}
```

Run the Workflow:

```bash
# Optional: ensure the background daemon is running without creating a Run
wave-flow start

wave-flow run ./.wave-flow/workflows/local-check.ts --input '{"target":"src"}'

# Revisit the Run ID printed by `run`
wave-flow inspect <run-id>

# Explicitly authorize call-level recovery for the same Run.
wave-flow resume <run-id>

# Inspect detected local capabilities
wave-flow capabilities --json
```

When an agent needs human help, its task prompt supplies stable identity arguments. The agent must pass them through unchanged:

```bash
wave-flow block --need-help "Describe the blocker and requested help" \
  --run-id <run-id> --node-id <node-id> --agent-session-id <agent-session-id>

# A human answer does not resume the node automatically.
wave-flow answer <block-request-id> --value '{"approved":true}'

# The original agent validates the answer and resumes itself.
wave-flow continue --block-request-id <block-request-id> \
  --run-id <run-id> --node-id <node-id> --agent-session-id <agent-session-id>
```

## Runtime semantics and limits

`run` prints a unique Run ID and writes Run data, events, session coordinates, and results to `~/.wave-flow/runs/<run-id>/`. Once the Run exists and the initial task is safely delivered, the command does not wait for the agent to finish. Instead, it subscribes to the daemon state stream in the current terminal, showing node starts, blocks, completions, and Run interruptions.

`Ctrl-C` only stops watching; it does not stop the daemon or the agent. Use `inspect` to return to the same Run. `start` only ensures the current user's global daemon is healthy and prints its address. `run` starts the daemon when needed, so `start` is optional.

The default path sends the initial task through the local App Server using `initialize → thread/start → turn/start` ACKs. The Codex session in tmux is for human viewing and interaction. Pass `--tmux-tui-input` to explicitly use the ordinary tmux TUI paste/history compatibility path. In both paths, only `wave-flow complete` is completion evidence. If delivery cannot be confirmed, the Run becomes `interrupted`; it is never treated as delivered.

Cross-daemon control recovery applies only when the original tmux and App Server thread remain verifiable: an answer may be saved first, and the original `block` reconnects with the same request ID to read it. Only the agent itself can call `continue`. Recovery never sends a new Codex turn, resends a prompt, reruns a node, or restores the Workflow call stack.

`resume` is a separate user authorization. It strictly verifies the Workflow source hash, input, project directory, and every `agent()` call's id, order, cwd, CLI, sandbox, model, schema, input, and prompt. A continuous matching completed prefix returns Journal results directly; the first interrupted or unverifiable node creates a new attempt, and later nodes stop reusing old results. A still-verifiable old session is never rerun by resume.

`capabilities --json` reports a three-state local capability snapshot. A discovered command merely means it can be probed; `unknown` means no environment conclusion exists yet, while `unavailable` means it has been confirmed unavailable. The runtime verifies tmux, Codex, and session state again during startup and delivery, and never treats binary presence or terminal text as successful delivery.

## Development and verification

Wave Flow uses Bun and TypeScript:

```bash
bun run check
bun test
git diff --check
```

This README documents only currently runnable behavior, commands, and limitations.
