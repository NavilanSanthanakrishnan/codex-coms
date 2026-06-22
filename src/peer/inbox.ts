import { readFile, writeFile, appendFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isProcessRunning } from "./pid.js";

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

export interface OutboxEntry {
  id: string;
  timestamp: string;
  to: string;
  type: string;
  summary: string;
  delivered: boolean;
  error?: string;
}

const INBOX_LOCK_STALE_MS = 5_000;
const INBOX_LOCK_TIMEOUT_MESSAGE = "timed out waiting for inbox lock";

export interface InboxWriteOptions {
  lockTimeoutMs?: number;
}

function inboxLockPath(dataDir: string): string {
  return path.join(dataDir, "inbox.lock");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readInboxLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path.join(lockPath, "pid"), "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function acquireInboxLock(dataDir: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
  const lockPath = inboxLockPath(dataDir);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await mkdir(lockPath, { recursive: false });
      await writeFile(path.join(lockPath, "pid"), `${process.pid}\n`, "utf8");
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > INBOX_LOCK_STALE_MS) {
          const pid = await readInboxLockPid(lockPath);
          if (!pid || !isProcessRunning(pid)) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
      }
      await sleep(Math.min(50, Math.max(1, timeoutMs - (Date.now() - started))));
    }
  }
  throw new Error(INBOX_LOCK_TIMEOUT_MESSAGE);
}

async function withInboxLock<T>(dataDir: string, operation: () => Promise<T>, options: InboxWriteOptions = {}): Promise<T> {
  await mkdir(dataDir, { recursive: true });
  const release = await acquireInboxLock(dataDir, options.lockTimeoutMs);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function appendInboxEntry(dataDir: string, entry: InboxEntry, options?: InboxWriteOptions): Promise<void> {
  await withInboxLock(dataDir, async () => {
    await appendFile(path.join(dataDir, "inbox.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }, options);
}

export async function appendOutboxEntry(dataDir: string, entry: Omit<OutboxEntry, "timestamp">): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(path.join(dataDir, "outbox.jsonl"), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
}

export async function readOutboxEntries(dataDir: string): Promise<OutboxEntry[]> {
  const file = path.join(dataDir, "outbox.jsonl");
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as OutboxEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
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

export async function markInboxRead(dataDir: string, ids?: string[], options?: InboxWriteOptions): Promise<number> {
  return withInboxLock(dataDir, async () => {
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
  }, options);
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

export function formatOutbox(entries: OutboxEntry[]): string {
  if (entries.length === 0) {
    return "Outbox is empty.";
  }
  return entries.map((entry) => {
    const state = entry.delivered ? "delivered" : "failed";
    const error = entry.error ? `\n  error: ${entry.error}` : "";
    return `- [${state}] ${entry.timestamp} to ${entry.to} (${entry.type})\n  ${entry.summary}${error}\n  id: ${entry.id}`;
  }).join("\n");
}
