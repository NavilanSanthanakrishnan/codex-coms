import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendInboxEntry, markInboxRead, readInboxEntries, type InboxEntry } from "../src/peer/inbox.js";

function entry(id: string): InboxEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    from: "alice",
    type: "agent.message",
    summary: `message ${id}`,
    read: false,
    payload: { text: `message ${id}` }
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("inbox persistence", () => {
  it("serializes appends and mark-read rewrites behind the same inbox lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-inbox-lock-"));
    const dataDir = path.join(root, ".codex-coms");
    try {
      const first = entry("message-1");
      const second = entry("message-2");
      await appendInboxEntry(dataDir, first);

      const lockPath = path.join(dataDir, "inbox.lock");
      await mkdir(lockPath, { recursive: true });

      let appendDone = false;
      let markDone = false;
      const append = appendInboxEntry(dataDir, second).then(() => {
        appendDone = true;
      });
      const mark = markInboxRead(dataDir, [first.id]).then(() => {
        markDone = true;
      });

      await sleep(100);
      expect(appendDone).toBe(false);
      expect(markDone).toBe(false);

      await rm(lockPath, { recursive: true, force: true });
      await Promise.all([append, mark]);

      const entries = await readInboxEntries(dataDir);
      expect(entries.map((item) => item.id).sort()).toEqual([first.id, second.id]);
      expect(entries.find((item) => item.id === first.id)?.read).toBe(true);
      expect(entries.find((item) => item.id === second.id)?.read).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a stale inbox lock before appending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-inbox-stale-lock-"));
    const dataDir = path.join(root, ".codex-coms");
    try {
      await mkdir(dataDir, { recursive: true });
      const lockPath = path.join(dataDir, "inbox.lock");
      await mkdir(lockPath, { recursive: true });
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      const message = entry("message-stale-lock");
      await appendInboxEntry(dataDir, message);

      const entries = await readInboxEntries(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe(message.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a stale inbox lock owned by a live process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-inbox-live-lock-"));
    const dataDir = path.join(root, ".codex-coms");
    try {
      await mkdir(dataDir, { recursive: true });
      const lockPath = path.join(dataDir, "inbox.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "pid"), `${process.pid}\n`, "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      await expect(appendInboxEntry(dataDir, entry("message-live-lock"), { lockTimeoutMs: 100 }))
        .rejects.toThrow("timed out waiting for inbox lock");
      expect(await readInboxEntries(dataDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
