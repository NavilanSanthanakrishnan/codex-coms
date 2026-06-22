import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  timestamp?: string;
  event: string;
  actor?: string;
  peer?: string;
  messageId?: string;
  result?: "allowed" | "denied" | "ok" | "error";
  details?: Record<string, unknown>;
}

const sensitiveKeyPattern = /(token|secret|password|authorization|cookie|key)/i;
const contentKeyPattern = /^(payload|content|contentBase64|dataBase64|body|text|raw|bytes|buffer)$/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = sensitiveKeyPattern.test(key) || contentKeyPattern.test(key) ? "[redacted]" : redactSensitive(item);
  }
  return output;
}

export async function appendAudit(dataDir: string, event: AuditEvent): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const redacted = redactSensitive({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString()
  });
  await appendFile(path.join(dataDir, "audit.jsonl"), `${JSON.stringify(redacted)}\n`, "utf8");
}

export async function readAuditLog(dataDir: string): Promise<AuditEvent[]> {
  const file = path.join(dataDir, "audit.jsonl");
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
