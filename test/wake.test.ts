import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../src/config.js";
import { PeerSidecar, sendAgentMessage } from "../src/peer/client.js";
import { readInboxEntries } from "../src/peer/inbox.js";
import { RelayServer } from "../src/relay/server.js";
import { dispatchWakeEvent, drainPendingWakeEvents, readPendingWakeEvents, readWakeEvents } from "../src/wake/codexWake.js";

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
      const markerContent = await waitFor(async () => {
        try {
          return await readFile(marker, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      });
      const markerJson = JSON.parse(markerContent) as Record<string, string>;
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
});
