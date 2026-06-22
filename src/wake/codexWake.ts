import { spawn } from "node:child_process";
import { appendAudit } from "../audit/auditLog.js";

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
