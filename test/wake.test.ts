import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initWorkspace } from "../src/config.js";
import { PeerSidecar, sendAgentMessage } from "../src/peer/client.js";
import { appendInboxEntry, readInboxEntries } from "../src/peer/inbox.js";
import { RelayServer } from "../src/relay/server.js";
import { dispatchWakeEvent, drainPendingWakeEvents, readPendingWakeEvents, readWakeEvents, waitForPendingWakeEvents } from "../src/wake/codexWake.js";

const execFileAsync = promisify(execFile);
const cliArgs = ["--import", "tsx", "src/cli.ts"];

async function waitFor<T>(producer: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await producer();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for condition");
}

describe("wake events", () => {
  it("queues a local wake event when a sidecar receives a peer message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-sidecar-"));
    const relay = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const started = await relay.start();
    const aliceWorkspace = path.join(root, "alice");
    const bobWorkspace = path.join(root, "bob");
    await mkdir(aliceWorkspace, { recursive: true });
    await mkdir(bobWorkspace, { recursive: true });
    const alice = await initWorkspace({
      agentId: "alice",
      workspace: aliceWorkspace,
      relay: started.url,
      room: "pair",
      token: "test-token"
    });
    const bob = await initWorkspace({
      agentId: "bob",
      workspace: bobWorkspace,
      relay: started.url,
      room: "pair",
      token: "test-token"
    });
    const bobSidecar = new PeerSidecar(bob);
    await bobSidecar.start();
    try {
      const message = await sendAgentMessage(alice, "bob", "wake up when this arrives");
      const event = await waitFor(async () => {
        const events = await readPendingWakeEvents(bob.dataDir);
        return events.find((item) => item.inboxEntryId === message.id);
      });
      expect(event.from).toBe("alice");
      expect(event.localAgentId).toBe("bob");
      expect(event.priority).toBe("normal");
      expect(event.summary).toContain("wake up");
      expect(event.eventPath).toContain(path.join(".codex-coms", "wake", "events"));
      expect((await readInboxEntries(bob.dataDir)).some((entry) => entry.id === message.id)).toBe(true);

      expect(await drainPendingWakeEvents(bob.dataDir, 10)).toEqual([event]);
      expect(await readPendingWakeEvents(bob.dataDir)).toHaveLength(0);
      expect(await readWakeEvents(bob.dataDir)).toHaveLength(1);
    } finally {
      await bobSidecar.stop();
      await relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a configured local wake command with event path and metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-command-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      const marker = path.join(root, "marker.json");
      const script = path.join(root, "wake-script.mjs");
      await writeFile(script, [
        "import { writeFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "const eventPathArg = process.argv[3];",
        "await writeFile(marker, JSON.stringify({",
        "  eventPathArg,",
        "  eventPathEnv: process.env.CODEX_COMS_WAKE_EVENT_PATH,",
        "  agent: process.env.CODEX_COMS_AGENT_ID,",
        "  from: process.env.CODEX_COMS_WAKE_FROM,",
        "  type: process.env.CODEX_COMS_WAKE_TYPE,",
        "  priority: process.env.CODEX_COMS_WAKE_PRIORITY",
        "}, null, 2));"
      ].join("\n"), "utf8");

      const result = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: {
          id: "message-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "workspace.grant.request",
          summary: "alice requested a file",
          actionHint: "Review before granting.",
          read: false,
          payload: { path: "notes", reason: "context" }
        },
        config: {
          enabled: true,
          command: [process.execPath, script, marker]
        }
      });

      expect(result.commandStarted).toBe(true);
      const markerJson = await waitFor(async () => {
        try {
          return JSON.parse(await readFile(marker, "utf8")) as Record<string, string>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          if (error instanceof SyntaxError) {
            return undefined;
          }
          throw error;
        }
      });
      expect(markerJson.eventPathArg).toBe(result.eventPath);
      expect(markerJson.eventPathEnv).toBe(result.eventPath);
      expect(markerJson.agent).toBe("bob");
      expect(markerJson.from).toBe("alice");
      expect(markerJson.type).toBe("workspace.grant.request");
      expect(markerJson.priority).toBe("action");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for and drains the next local wake event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-wait-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      const waiting = waitForPendingWakeEvents(dataDir, {
        limit: 1,
        timeoutMs: 2000,
        pollMs: 25
      });
      await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: {
          id: "message-wait-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "wake wait should claim this",
          actionHint: "reply when ready",
          read: false,
          payload: { text: "wake wait should claim this" }
        }
      });

      const events = await waiting;
      expect(events).toHaveLength(1);
      expect(events[0]?.inboxEntryId).toBe("message-wait-1");
      expect(events[0]?.summary).toContain("wake wait");
      expect(await readPendingWakeEvents(dataDir)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drains matching wake events when inbox entries are marked read through the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-inbox-read-"));
    try {
      const workspace = path.join(root, "bob");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const entry = {
        id: "message-read-1",
        timestamp: new Date().toISOString(),
        from: "alice",
        type: "agent.message",
        summary: "manual inbox read should retire wake event",
        actionHint: "reply when ready",
        read: false,
        payload: { text: "manual inbox read should retire wake event" }
      };
      await appendInboxEntry(config.dataDir, entry);
      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry
      });

      expect(await readPendingWakeEvents(config.dataDir)).toHaveLength(1);

      const { stdout } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "inbox",
        "--workspace",
        workspace,
        "--mark-read"
      ], { cwd: process.cwd() });

      expect(stdout).toContain("Marked 1 message(s) read.");
      expect(stdout).toContain("Drained 1 wake event(s).");
      expect((await readInboxEntries(config.dataDir))[0]?.read).toBe(true);
      expect(await readPendingWakeEvents(config.dataDir)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves inbox entries unread when the matching wake drain fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-inbox-read-lock-"));
    try {
      const workspace = path.join(root, "bob");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const entry = {
        id: "message-read-lock-1",
        timestamp: new Date().toISOString(),
        from: "alice",
        type: "agent.message",
        summary: "manual inbox read should wait for wake drain",
        actionHint: "reply when ready",
        read: false,
        payload: { text: "manual inbox read should wait for wake drain" }
      };
      await appendInboxEntry(config.dataDir, entry);
      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry
      });
      const lockPath = path.join(config.dataDir, "wake-drain.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "pid"), `${process.pid}\n`, "utf8");

      let stderr = "";
      try {
        await execFileAsync(process.execPath, [
          ...cliArgs,
          "inbox",
          "--workspace",
          workspace,
          "--mark-read"
        ], { cwd: process.cwd() });
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? "");
      }

      expect(stderr).toContain("timed out waiting for wake drain lock");
      expect((await readInboxEntries(config.dataDir))[0]?.read).toBe(false);
      expect(await readPendingWakeEvents(config.dataDir)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors wake wait timeout while the drain lock is held", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-wait-lock-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      await mkdir(path.join(dataDir, "wake-drain.lock"), { recursive: true });

      const started = Date.now();
      const events = await waitForPendingWakeEvents(dataDir, {
        limit: 1,
        timeoutMs: 50,
        pollMs: 10
      });

      expect(events).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a stale wake drain lock owned by a dead process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-dead-lock-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      const lockPath = path.join(dataDir, "wake-drain.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "pid"), "99999999\n", "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      await expect(drainPendingWakeEvents(dataDir, 1, 500)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a stale wake drain lock owned by a live process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-live-lock-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      const lockPath = path.join(dataDir, "wake-drain.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "pid"), `${process.pid}\n`, "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      await expect(drainPendingWakeEvents(dataDir, 1, 100)).rejects.toThrow("timed out waiting for wake drain lock");
      await expect(readFile(path.join(lockPath, "pid"), "utf8")).resolves.toBe(`${process.pid}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
