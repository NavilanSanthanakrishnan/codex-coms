import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendAudit } from "../audit/auditLog.js";
import type { InboxEntry } from "../peer/inbox.js";

export interface WakeConfig {
  enabled?: boolean;
  command?: string[];
  staticPrompt?: string;
  inboxSummaryPath?: string;
}

export async function maybeWakeCodex(dataDir: string, localAgentId: string, config?: WakeConfig): Promise<void> {
  if (!config?.enabled || !config.command?.length) {
    return;
  }
  const [command, ...args] = config.command;
  if (!command) {
    return;
  }
  const safeArgs = [...args];
  if (config.staticPrompt) {
    safeArgs.push(config.staticPrompt);
  }
  if (config.inboxSummaryPath) {
    safeArgs.push(config.inboxSummaryPath);
  }
  await appendAudit(dataDir, {
    event: "wake_attempted",
    actor: localAgentId,
    result: "ok",
    details: { command }
  });
  const child = spawn(command, safeArgs, {
    shell: false,
    stdio: "ignore",
    detached: true
  }) as unknown as { unref: () => void };
  child.unref();
}

export async function writeInboxSummary(dataDir: string, entry: InboxEntry): Promise<string> {
  const file = path.join(dataDir, "inbox-summary.txt");
  const summary = [
    "codex-coms received an unread peer event.",
    `from: ${entry.from}`,
    `type: ${entry.type}`,
    `timestamp: ${entry.timestamp}`,
    `summary: ${entry.summary}`,
    "Run codex-coms inbox to inspect the full local inbox before taking action."
  ].join("\n");
  await writeFile(file, `${summary}\n`, "utf8");
  return file;
}
