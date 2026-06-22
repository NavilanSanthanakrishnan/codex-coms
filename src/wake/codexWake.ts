import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendAudit } from "../audit/auditLog.js";
import type { InboxEntry } from "../peer/inbox.js";
import { isProcessRunning } from "../peer/pid.js";

export interface WakeConfig {
  enabled?: boolean;
  command?: string[];
  staticPrompt?: string;
  appendEventPath?: boolean;
  allowConcurrent?: boolean;
}

export type WakePriority = "normal" | "action" | "error";

export interface WakeEvent {
  id: string;
  inboxEntryId: string;
  createdAt: string;
  messageTimestamp: string;
  localAgentId: string;
  workspace: string;
  dataDir: string;
  from: string;
  type: string;
  summary: string;
  actionHint?: string;
  priority: WakePriority;
  eventPath?: string;
  inboxSummaryPath?: string;
}

interface WakeState {
  drainedIds: string[];
  updatedAt?: string;
}

interface WakeCommandState {
  attemptedIds: string[];
  updatedAt?: string;
}

export interface WakeDispatchPaths {
  eventPath: string;
  inboxSummaryPath: string;
}

export interface WakeDispatchResult {
  event: WakeEvent;
  eventPath: string;
  inboxSummaryPath: string;
  commandStarted: boolean;
}

export interface WakeWaitOptions {
  limit?: number;
  timeoutMs?: number;
  pollMs?: number;
}

const MAX_DRAINED_IDS = 5000;
const MAX_COMMAND_ATTEMPTED_IDS = 5000;
const DRAIN_LOCK_STALE_MS = 5_000;
const COMMAND_LOCK_STALE_MS = 5_000;
const DRAIN_LOCK_TIMEOUT_MESSAGE = "timed out waiting for wake drain lock";

function wakeRoot(dataDir: string): string {
  return path.join(dataDir, "wake");
}

function wakeEventsLogPath(dataDir: string): string {
  return path.join(dataDir, "wake-events.jsonl");
}

function wakeStatePath(dataDir: string): string {
  return path.join(dataDir, "wake-state.json");
}

function wakeDrainLockPath(dataDir: string): string {
  return path.join(dataDir, "wake-drain.lock");
}

function wakeCommandLockPath(dataDir: string): string {
  return path.join(dataDir, "wake-command.lock");
}

function wakeCommandStatePath(dataDir: string): string {
  return path.join(dataDir, "wake-command-state.json");
}

function safeEventBasename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function safeEventFilename(id: string): string {
  return `${safeEventBasename(id)}.json`;
}

function eventPathFor(dataDir: string, id: string): string {
  return path.join(wakeRoot(dataDir), "events", safeEventFilename(id));
}

function inboxSummaryPathFor(dataDir: string, id: string): string {
  return path.join(wakeRoot(dataDir), "summaries", `${safeEventBasename(id)}.txt`);
}

function latestEventPath(dataDir: string): string {
  return path.join(wakeRoot(dataDir), "latest.json");
}

function latestInboxSummaryPath(dataDir: string): string {
  return path.join(wakeRoot(dataDir), "inbox-summary.txt");
}

function priorityFor(entry: InboxEntry): WakePriority {
  if (entry.type === "error") {
    return "error";
  }
  if (entry.type === "workspace.grant.request" || entry.type === "workspace.grant.created" || entry.type === "file.complete") {
    return "action";
  }
  return "normal";
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
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

async function acquireDrainLock(dataDir: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
  const lockPath = wakeDrainLockPath(dataDir);
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
        if (Date.now() - info.mtimeMs > DRAIN_LOCK_STALE_MS) {
          const pid = await readLockPid(lockPath);
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
  throw new Error(DRAIN_LOCK_TIMEOUT_MESSAGE);
}

async function tryAcquireCommandSlot(dataDir: string): Promise<{ lockPath: string } | undefined> {
  const lockPath = wakeCommandLockPath(dataDir);
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      return { lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const info = await stat(lockPath);
        const pid = await readLockPid(lockPath);
        if ((pid && !isProcessRunning(pid)) || (!pid && Date.now() - info.mtimeMs > COMMAND_LOCK_STALE_MS)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
        continue;
      }
      return undefined;
    }
  }
}

async function writeCommandSlotPid(lockPath: string, pid: number): Promise<void> {
  await writeFile(path.join(lockPath, "pid"), `${pid}\n`, "utf8");
}

async function releaseCommandSlotIfOwner(lockPath: string, pid: number): Promise<boolean> {
  try {
    if ((await readLockPid(lockPath)) === pid) {
      await rm(lockPath, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

function isDrainLockTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === DRAIN_LOCK_TIMEOUT_MESSAGE;
}

export function createWakeEvent(input: {
  dataDir: string;
  workspace: string;
  localAgentId: string;
  entry: InboxEntry;
}): WakeEvent {
  return {
    id: `wake_${input.entry.id}`,
    inboxEntryId: input.entry.id,
    createdAt: new Date().toISOString(),
    messageTimestamp: input.entry.timestamp,
    localAgentId: input.localAgentId,
    workspace: input.workspace,
    dataDir: input.dataDir,
    from: input.entry.from,
    type: input.entry.type,
    summary: input.entry.summary,
    actionHint: input.entry.actionHint,
    priority: priorityFor(input.entry)
  };
}

export async function appendWakeEvent(dataDir: string, event: WakeEvent): Promise<WakeDispatchPaths> {
  const eventPath = eventPathFor(dataDir, event.id);
  const inboxSummaryPath = await writeInboxSummary(dataDir, event);
  const persisted: WakeEvent = {
    ...event,
    eventPath,
    inboxSummaryPath
  };
  await mkdir(path.dirname(eventPath), { recursive: true });
  await appendFile(wakeEventsLogPath(dataDir), `${JSON.stringify(persisted)}\n`, "utf8");
  await writeFile(eventPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  await writeFile(latestEventPath(dataDir), `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return { eventPath, inboxSummaryPath };
}

export async function readWakeEvents(dataDir: string): Promise<WakeEvent[]> {
  try {
    const content = await readFile(wakeEventsLogPath(dataDir), "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as WakeEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readWakeState(dataDir: string): Promise<WakeState> {
  return readJson<WakeState>(wakeStatePath(dataDir), { drainedIds: [] });
}

async function readWakeCommandState(dataDir: string): Promise<WakeCommandState> {
  return readJson<WakeCommandState>(wakeCommandStatePath(dataDir), { attemptedIds: [] });
}

async function markWakeCommandAttempted(dataDir: string, id: string): Promise<void> {
  const state = await readWakeCommandState(dataDir);
  const attempted = new Set(state.attemptedIds);
  attempted.add(id);
  await mkdir(dataDir, { recursive: true });
  await writeFile(wakeCommandStatePath(dataDir), `${JSON.stringify({
    attemptedIds: [...attempted].slice(-MAX_COMMAND_ATTEMPTED_IDS),
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

export async function readPendingWakeEvents(dataDir: string): Promise<WakeEvent[]> {
  const [events, state] = await Promise.all([
    readWakeEvents(dataDir),
    readWakeState(dataDir)
  ]);
  const drained = new Set(state.drainedIds);
  return events.filter((event) => !drained.has(event.id));
}

export async function markWakeEventsDrained(dataDir: string, ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const state = await readWakeState(dataDir);
  const before = new Set(state.drainedIds);
  for (const id of ids) {
    before.add(id);
  }
  const drainedIds = [...before].slice(-MAX_DRAINED_IDS);
  await mkdir(dataDir, { recursive: true });
  await writeFile(wakeStatePath(dataDir), `${JSON.stringify({
    drainedIds,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  return ids.length;
}

export async function drainPendingWakeEvents(dataDir: string, limit: number, lockTimeoutMs = 10_000): Promise<WakeEvent[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new Error("lockTimeoutMs must be a non-negative integer");
  }
  await mkdir(dataDir, { recursive: true });
  const release = await acquireDrainLock(dataDir, lockTimeoutMs);
  try {
    const events = (await readPendingWakeEvents(dataDir)).slice(0, limit);
    await markWakeEventsDrained(dataDir, events.map((event) => event.id));
    return events;
  } finally {
    await release();
  }
}

export async function drainWakeEventsForInboxEntries(dataDir: string, inboxEntryIds: string[], lockTimeoutMs = 5_000): Promise<number> {
  if (inboxEntryIds.length === 0) {
    return 0;
  }
  await mkdir(dataDir, { recursive: true });
  const release = await acquireDrainLock(dataDir, lockTimeoutMs);
  try {
    const inboxEntryIdSet = new Set(inboxEntryIds);
    const events = await readPendingWakeEvents(dataDir);
    const wakeEventIds = events
      .filter((event) => inboxEntryIdSet.has(event.inboxEntryId))
      .map((event) => event.id);
    await markWakeEventsDrained(dataDir, wakeEventIds);
    return wakeEventIds.length;
  } finally {
    await release();
  }
}

export async function waitForPendingWakeEvents(dataDir: string, options: WakeWaitOptions = {}): Promise<WakeEvent[]> {
  const limit = options.limit ?? 1;
  const timeoutMs = options.timeoutMs ?? 0;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a non-negative integer");
  }
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error("pollMs must be a positive integer");
  }
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const drainForWait = async (): Promise<{ events: WakeEvent[]; timedOut: boolean }> => {
    const remainingMs = deadline === undefined ? 10_000 : Math.max(0, deadline - Date.now());
    if (deadline !== undefined && remainingMs === 0) {
      return { events: [], timedOut: true };
    }
    try {
      return {
        events: await drainPendingWakeEvents(dataDir, limit, remainingMs),
        timedOut: false
      };
    } catch (error) {
      if (isDrainLockTimeout(error)) {
        return {
          events: [],
          timedOut: deadline !== undefined && Date.now() >= deadline
        };
      }
      throw error;
    }
  };
  const initial = await drainForWait();
  const existing = initial.events;
  if (existing.length > 0) {
    return existing;
  }
  if (initial.timedOut) {
    return [];
  }
  await mkdir(dataDir, { recursive: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    let watcher: FSWatcher | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const interval = setInterval(() => {
      check().catch(fail);
    }, pollMs);
    interval.unref?.();
    const cleanup = () => {
      watcher?.close();
      clearInterval(interval);
      if (timeout) {
        clearTimeout(timeout);
      }
    };
    const finish = (events: WakeEvent[]) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(events);
    };
    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }
    async function check(): Promise<void> {
      if (settled || checking) {
        return;
      }
      checking = true;
      try {
        const result = await drainForWait();
        if (result.events.length > 0) {
          finish(result.events);
        } else if (result.timedOut) {
          finish([]);
        }
      } finally {
        checking = false;
      }
    }
    try {
      watcher = watch(dataDir, (_eventType, filename) => {
        if (!filename || String(filename) === "wake-events.jsonl") {
          check().catch(fail);
        }
      });
      watcher.on("error", fail);
    } catch (error) {
      fail(error);
      return;
    }
    if (timeoutMs > 0) {
      const timeoutDelayMs = deadline === undefined ? timeoutMs : Math.max(0, deadline - Date.now());
      timeout = setTimeout(() => finish([]), timeoutDelayMs);
      timeout.unref?.();
    }
    check().catch(fail);
  });
}

export function formatWakeEvents(events: WakeEvent[]): string {
  if (events.length === 0) {
    return "Wake queue is empty.";
  }
  return events.map((event) => {
    const hint = event.actionHint ? `\n  action: ${event.actionHint}` : "";
    return `- [${event.priority}] ${event.createdAt} from ${event.from} (${event.type})\n  ${event.summary}${hint}\n  event: ${event.id}\n  inbox: ${event.inboxEntryId}`;
  }).join("\n");
}

async function maybeDispatchNextPendingWakeCommand(dataDir: string, localAgentId: string, config: WakeConfig | undefined): Promise<void> {
  if (!config?.enabled || !config.command?.length || config.allowConcurrent) {
    return;
  }
  const [events, commandState] = await Promise.all([
    readPendingWakeEvents(dataDir),
    readWakeCommandState(dataDir)
  ]);
  const attempted = new Set(commandState.attemptedIds);
  const next = events.find((event) => !attempted.has(event.id));
  if (!next) {
    return;
  }
  await maybeWakeCodex(dataDir, localAgentId, config, next, {
    eventPath: next.eventPath ?? eventPathFor(dataDir, next.id),
    inboxSummaryPath: next.inboxSummaryPath ?? inboxSummaryPathFor(dataDir, next.id)
  });
}

export async function maybeWakeCodex(dataDir: string, localAgentId: string, config: WakeConfig | undefined, event: WakeEvent, paths: WakeDispatchPaths): Promise<boolean> {
  if (!config?.enabled || !config.command?.length) {
    return false;
  }
  const [command, ...args] = config.command;
  if (!command) {
    return false;
  }
  const safeArgs = [...args];
  if (config.staticPrompt) {
    safeArgs.push(config.staticPrompt);
  }
  if (config.appendEventPath !== false) {
    safeArgs.push(paths.eventPath);
  }
  const commandSlot = config.allowConcurrent ? undefined : await tryAcquireCommandSlot(dataDir);
  if (!config.allowConcurrent && !commandSlot) {
    await appendAudit(dataDir, {
      event: "wake_coalesced",
      actor: localAgentId,
      result: "ok",
      details: { command, wakeEventId: event.id, priority: event.priority, reason: "wake command already running" }
    });
    return false;
  }
  await appendAudit(dataDir, {
    event: "wake_attempted",
    actor: localAgentId,
    result: "ok",
    details: { command, wakeEventId: event.id, priority: event.priority }
  });
  if (!config.allowConcurrent) {
    await markWakeCommandAttempted(dataDir, event.id);
  }
  try {
    const child = spawn(command, safeArgs, {
      shell: false,
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        CODEX_COMS_AGENT_ID: localAgentId,
        CODEX_COMS_DATA_DIR: dataDir,
        CODEX_COMS_WORKSPACE: event.workspace,
        CODEX_COMS_WAKE_EVENT_ID: event.id,
        CODEX_COMS_WAKE_EVENT_PATH: paths.eventPath,
        CODEX_COMS_INBOX_SUMMARY_PATH: paths.inboxSummaryPath,
        CODEX_COMS_WAKE_FROM: event.from,
        CODEX_COMS_WAKE_TYPE: event.type,
        CODEX_COMS_WAKE_PRIORITY: event.priority
      }
    });
    const childPid = child.pid;
    const releaseCommandSlot = (dispatchNext: boolean) => {
      if (commandSlot && childPid) {
        releaseCommandSlotIfOwner(commandSlot.lockPath, childPid)
          .then((released) => {
            if (released && dispatchNext) {
              return maybeDispatchNextPendingWakeCommand(dataDir, localAgentId, config);
            }
            return undefined;
          })
          .catch(() => undefined);
      }
    };
    child.once("error", (error) => {
      releaseCommandSlot(false);
      appendAudit(dataDir, {
        event: "wake_failed",
        actor: localAgentId,
        result: "error",
        details: { command, wakeEventId: event.id, reason: error.message }
      }).catch(() => undefined);
    });
    child.once("exit", () => releaseCommandSlot(true));
    if (commandSlot) {
      if (childPid) {
        await writeCommandSlotPid(commandSlot.lockPath, childPid);
        if (!isProcessRunning(childPid)) {
          if (await releaseCommandSlotIfOwner(commandSlot.lockPath, childPid)) {
            await maybeDispatchNextPendingWakeCommand(dataDir, localAgentId, config);
          }
        }
      } else {
        await rm(commandSlot.lockPath, { recursive: true, force: true });
      }
    }
    child.unref();
    return true;
  } catch (error) {
    if (commandSlot) {
      await rm(commandSlot.lockPath, { recursive: true, force: true });
    }
    await appendAudit(dataDir, {
      event: "wake_failed",
      actor: localAgentId,
      result: "error",
      details: { command, wakeEventId: event.id, reason: (error as Error).message }
    });
    return false;
  }
}

export async function dispatchWakeEvent(input: {
  dataDir: string;
  workspace: string;
  localAgentId: string;
  entry: InboxEntry;
  config?: WakeConfig;
}): Promise<WakeDispatchResult> {
  const event = createWakeEvent(input);
  const paths = await appendWakeEvent(input.dataDir, event);
  await appendAudit(input.dataDir, {
    event: "wake_queued",
    actor: input.localAgentId,
    peer: input.entry.from,
    messageId: input.entry.id,
    result: "ok",
    details: { wakeEventId: event.id, priority: event.priority }
  });
  const commandStarted = await maybeWakeCodex(input.dataDir, input.localAgentId, input.config, event, paths);
  return {
    event,
    eventPath: paths.eventPath,
    inboxSummaryPath: paths.inboxSummaryPath,
    commandStarted
  };
}

export async function writeInboxSummary(dataDir: string, event: WakeEvent): Promise<string> {
  const file = inboxSummaryPathFor(dataDir, event.id);
  const latest = latestInboxSummaryPath(dataDir);
  const summary = [
    "codex-coms received an unread peer event.",
    `wakeEvent: ${event.id}`,
    `inboxEntry: ${event.inboxEntryId}`,
    `from: ${event.from}`,
    `type: ${event.type}`,
    `priority: ${event.priority}`,
    `timestamp: ${event.messageTimestamp}`,
    `summary: ${event.summary}`,
    "Run codex-coms wake drain to claim pending wake events, then codex-coms inbox to inspect the full local inbox before taking action."
  ].join("\n");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${summary}\n`, "utf8");
  await writeFile(latest, `${summary}\n`, "utf8");
  return file;
}
