#!/usr/bin/env bun
import { DaemonClient } from "./daemon-client";
import { formatCapabilities, formatSnapshot, helpText } from "./output";
import { parseCommand } from "./parse-command";
import { withLocalDaemon } from "../daemon/local-daemon-lifecycle";

/** CLI 主入口；run 和 inspect 均只经 localhost daemon 访问 Run 状态。 */
export async function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd(), write: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); }): Promise<void> {
  const command = parseCommand(argv, cwd);
  if (command.kind === "help") { write(helpText); return; }
  await withLocalDaemon(async (baseUrl) => {
    const client = new DaemonClient(baseUrl);
    if (command.kind === "capabilities") {
      const snapshot = await client.capabilities();
      write(command.json ? JSON.stringify(snapshot, null, 2) : formatCapabilities(snapshot));
      return;
    }
    const response = command.kind === "run"
      ? await client.createRun({ workflowPath: command.workflowPath, cwd: command.cwd, input: command.input })
      : await client.inspect(command.runId, command.cwd);
    write(formatSnapshot(response.snapshot));
  });
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`wave-flow: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
