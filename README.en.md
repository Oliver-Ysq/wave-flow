# Wave Flow

> A dynamic workflow for AI coding agents — keeping long-running work
> controllable, visible, and recoverable through CLI and locally managed sessions.

*Inspired by Claude Code Dynamic Workflows.*

[中文](./README.md) | English

## Available today

- Author reusable dynamic workflows in TypeScript; agent nodes advance from actual workflow calls at runtime.
- Host one real, long-lived, interactive local CLI (Codex or Kimi) ACP session for each agent node.
- Create a Run with `wave-flow run`; receive its Run ID after safe initial-task delivery, then watch live state changes in the current terminal.
- Read a Run again with `wave-flow inspect <run-id>`.
- Let agents report validated structured completion results through `wave-flow complete`, and request human help through `block / answer / continue`; terminal text is never completion evidence.
- After a daemon restart, a still-verifiable managed session can continue `answer / block / continue / complete` control operations without resending the task or creating a new agent.
- `wave-flow resume <run-id>` is user-authorized call-level recovery: it strictly reuses a matching completed prefix and creates a new attempt from the first unverifiable node.
- Use `wave-flow pause / recover / stop <run-id>` to control a managed Run: pause stops the active turn and managed background terminals, recover creates a continuation turn in the same thread, and stop is terminal.
- The daemon serves a same-origin Local Web overview for Runs, phases, agents, results, and pending human help.
- A Tauri desktop app is available for the current macOS Apple Silicon build. It safely discovers or starts the loopback daemon and lets users view and create Runs directly.
- Persist Runs, events, ACP session bindings, and results in the local daemon.

## Current boundaries

- `agent()` accepts `cli: "codex"` or `cli: "kimi"`; the CLI must be verified in the desktop execution-base settings (any verified runtime is a Worker candidate).
- Wave Flow is for one local user; its daemon runs locally.
- TraeX and Retry are not implemented.
- By default, Agent nodes run in independent Codex ACP Worker sessions. ACP stream events and turn completion are not completion evidence.

## Quick start

CLI development requires [Bun](https://bun.sh/) and the Codex CLI or Kimi CLI (at least one).

Desktop users do not need to start the daemon or run `wave-flow start` manually. Build the current macOS Apple Silicon desktop app in a development environment:

```bash
bun install
bun run desktop:build
# Open src-tauri/target/release/bundle/macos/Wave Flow.app
```

The desktop app safely discovers an existing daemon or starts a bundled Bun sidecar. Closing its window does not stop the daemon or active Runs; reopening it shows the user-level Run archive again.

Link the package locally:

```bash
bun link
```

Build the same-origin Local Web assets:

```bash
bun run web:build
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

# Print the Local Web URL
wave-flow web

# Gracefully stop the verified daemon for the current user
wave-flow close

wave-flow run ./.wave-flow/workflows/local-check.ts --input '{"target":"src"}'

# Revisit the Run ID printed by `run`
wave-flow inspect <run-id>

# Explicitly authorize call-level recovery for the same Run.
wave-flow resume <run-id>

# Pause, recover, or stop a Run held by the current daemon.
wave-flow pause <run-id>
wave-flow recover <run-id>
wave-flow stop <run-id>

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

Run `wave-flow web` to print the Local Web URL, such as `http://127.0.0.1:<port>/`. It talks only to the local daemon and can show Run history, submit block answers, pause, recover, stop, or explicitly replay an interrupted Run.

`web` prints its actual descriptor, heartbeat, process-start-identity, and `/health` verification steps. `close` requests that only the verified daemon gracefully exits and clears its descriptor / lock; it never guesses at or kills an arbitrary PID.

Use `bun run web:dev` while developing the React interface. Vite is only the frontend development server; production assets are always served from the daemon origin.

Default ACP `pause` is not an OS-level process freeze. It requests cancellation of the current ACP Worker turn and enters `paused` only after cancellation is confirmed. `recover` does not resend the original prompt: it opens a new turn in the same ACP session to inspect the workspace before continuing. Side effects deliberately detached from Codex management, such as remote services, are outside this pause guarantee. If the daemon restarts while pausing, paused, or recovering, Wave Flow records `interrupted` rather than fabricating a recover; use explicit `resume` instead.

The default path uses the built-in `codex-acp` adapter with a user-selected, verified local Codex runtime. Only `wave-flow complete` is completion evidence. If delivery cannot be confirmed, the Run becomes `interrupted`; it is never treated as delivered. Same-daemon recovery uses `pause → cancel → recover` in the same ACP session.

After a daemon restart, active ACP nodes become `interrupted`. Wave Flow neither resumes the old session nor resends its prompt or block answer. Explicit `resume` validates the Workflow source hash, input, cwd, and invocation fingerprint, then starts a new attempt from the first interrupted or mismatched node.

`resume` is a separate user authorization. It strictly verifies the Workflow source hash, input, project directory, and every `agent()` call's id, order, cwd, CLI, sandbox, model, schema, input, and prompt. A continuous matching completed prefix returns Journal results directly; the first interrupted or unverifiable node creates a new attempt, and later nodes stop reusing old results. A still-verifiable old session is never rerun by resume.

`capabilities --json` reports a three-state local capability snapshot. A discovered command merely means it can be probed; `unknown` means no environment conclusion exists yet, while `unavailable` means it has been confirmed unavailable. The runtime verifies Codex ACP and session state again during startup and delivery, and never treats binary presence or ACP turn completion as successful delivery.

## Development and verification

Wave Flow uses Bun and TypeScript:

```bash
bun run check
bun test
git diff --check
```

This README documents only currently runnable behavior, commands, and limitations.
