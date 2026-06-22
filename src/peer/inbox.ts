import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface InboxEntry {
  id: string;
  timestamp: string;
  from: string;
  type: string;
  summary: string;
  actionHint?: string;
  read: boolean;
  payload: Record<string, unknown>;
}

export async function appendInboxEntry(dataDir: string, entry: InboxEntry): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(path.join(dataDir, "inbox.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function appendOutboxEntry(dataDir: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(path.join(dataDir, "outbox.jsonl"), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

export async function readInboxEntries(dataDir: string): Promise<InboxEntry[]> {
  const file = path.join(dataDir, "inbox.jsonl");
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as InboxEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function markInboxRead(dataDir: string, ids?: string[]): Promise<number> {
  const entries = await readInboxEntries(dataDir);
  const idSet = ids ? new Set(ids) : undefined;
  let changed = 0;
  const next = entries.map((entry) => {
    if (!entry.read && (!idSet || idSet.has(entry.id))) {
      changed += 1;
      return { ...entry, read: true };
    }
    return entry;
  });
  await writeFile(path.join(dataDir, "inbox.jsonl"), next.map((entry) => JSON.stringify(entry)).join("\n") + (next.length ? "\n" : ""), "utf8");
  return changed;
}

export function formatInbox(entries: InboxEntry[]): string {
  if (entries.length === 0) {
    return "Inbox is empty.";
  }
  return entries.map((entry) => {
    const state = entry.read ? "read" : "unread";
    const hint = entry.actionHint ? `\n  action: ${entry.actionHint}` : "";
    return `- [${state}] ${entry.timestamp} from ${entry.from} (${entry.type})\n  ${entry.summary}${hint}\n  id: ${entry.id}`;
  }).join("\n");
}
