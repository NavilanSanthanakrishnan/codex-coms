import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initWorkspace, updateConfig } from "../src/config.js";
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

  it("triggers the configured wake command for a pending event after wake is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-trigger-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const marker = path.join(root, "trigger-marker.json");
      const script = path.join(root, "wake-trigger-script.mjs");
      await writeFile(script, [
        "import { writeFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "const eventPathArg = process.argv[3];",
        "await writeFile(marker, JSON.stringify({",
        "  eventPathArg,",
        "  eventPathEnv: process.env.CODEX_COMS_WAKE_EVENT_PATH,",
        "  eventId: process.env.CODEX_COMS_WAKE_EVENT_ID,",
        "  agent: process.env.CODEX_COMS_AGENT_ID,",
        "  from: process.env.CODEX_COMS_WAKE_FROM",
        "}, null, 2));"
      ].join("\n"), "utf8");

      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry: {
          id: "message-trigger-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "wake trigger should start later",
          actionHint: "Inspect the pending event.",
          read: false,
          payload: { text: "wake trigger should start later" }
        }
      });

      await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "command",
        process.execPath,
        script,
        marker
      ], { cwd: process.cwd() });

      const { stdout: triggerJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--json"
      ], { cwd: process.cwd() });
      const trigger = JSON.parse(triggerJson) as Record<string, unknown>;
      expect(trigger.reason).toBe("started");
      expect(trigger.commandStarted).toBe(true);

      const markerContent = await waitFor(async () => {
        try {
          return JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
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
      expect(markerContent.eventId).toBe("wake_message-trigger-1");
      expect(markerContent.agent).toBe("bob");
      expect(markerContent.from).toBe("alice");
      expect(markerContent.eventPathArg).toBe(markerContent.eventPathEnv);
      expect(String(markerContent.eventPathArg)).toContain(path.join(".codex-coms", "wake", "events"));

      const { stdout: secondTriggerJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--json"
      ], { cwd: process.cwd() });
      const secondTrigger = JSON.parse(secondTriggerJson) as Record<string, unknown>;
      expect(secondTrigger.reason).toBe("already_attempted");
      expect(secondTrigger.commandStarted).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries an attempted pending wake event only when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-trigger-retry-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const marker = path.join(root, "retry-marker.txt");
      const script = path.join(root, "wake-retry-script.mjs");
      await writeFile(script, [
        "import { appendFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "await appendFile(marker, `${process.env.CODEX_COMS_WAKE_EVENT_ID}\\n`);"
      ].join("\n"), "utf8");

      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry: {
          id: "message-retry-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "wake trigger retry should be explicit",
          actionHint: "Retry after fixing local adapter.",
          read: false,
          payload: { text: "wake trigger retry should be explicit" }
        }
      });
      await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "command",
        process.execPath,
        script,
        marker
      ], { cwd: process.cwd() });
      await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--json"
      ], { cwd: process.cwd() });
      await waitFor(async () => {
        const content = await readFile(marker, "utf8").catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        });
        return content?.split("\n").filter(Boolean).length === 1 ? content : undefined;
      });

      const { stdout: blockedRetryJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--json"
      ], { cwd: process.cwd() });
      const blockedRetry = JSON.parse(blockedRetryJson) as Record<string, unknown>;
      expect(blockedRetry.reason).toBe("already_attempted");
      expect(blockedRetry.commandStarted).toBe(false);

      const { stdout: retryJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--retry-attempted",
        "--json"
      ], { cwd: process.cwd() });
      const retry = JSON.parse(retryJson) as Record<string, unknown>;
      expect(retry.reason).toBe("started");
      expect(retry.commandStarted).toBe(true);
      expect(retry.retriedAttempted).toBe(true);

      const finalMarker = await waitFor(async () => {
        const content = await readFile(marker, "utf8");
        return content.split("\n").filter(Boolean).length === 2 ? content : undefined;
      });
      expect(finalMarker.split("\n").filter(Boolean)).toEqual([
        "wake_message-retry-1",
        "wake_message-retry-1"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("triggers a targeted pending wake event by wake id or inbox id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-trigger-target-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const marker = path.join(root, "target-marker.txt");
      const script = path.join(root, "wake-target-script.mjs");
      await writeFile(script, [
        "import { appendFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "await appendFile(marker, `${process.env.CODEX_COMS_WAKE_EVENT_ID}\\n`);"
      ].join("\n"), "utf8");
      await updateConfig(config, {
        wake: {
          enabled: true,
          command: [process.execPath, script, marker],
          allowConcurrent: true
        }
      });

      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry: {
          id: "message-target-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "first targeted wake event",
          read: false,
          payload: { text: "first targeted wake event" }
        }
      });
      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry: {
          id: "message-target-2",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "second targeted wake event",
          read: false,
          payload: { text: "second targeted wake event" }
        }
      });

      const { stdout: secondJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--event",
        "message-target-2",
        "--json"
      ], { cwd: process.cwd() });
      const second = JSON.parse(secondJson) as Record<string, unknown>;
      expect(second.reason).toBe("started");
      expect((second.event as Record<string, unknown>).id).toBe("wake_message-target-2");
      await waitFor(async () => {
        const content = await readFile(marker, "utf8").catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        });
        return content?.split("\n").filter(Boolean).length === 1 ? content : undefined;
      });

      const { stdout: firstJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--event",
        "wake_message-target-1",
        "--json"
      ], { cwd: process.cwd() });
      const first = JSON.parse(firstJson) as Record<string, unknown>;
      expect(first.reason).toBe("started");
      expect((first.event as Record<string, unknown>).inboxEntryId).toBe("message-target-1");

      const finalMarker = await waitFor(async () => {
        const content = await readFile(marker, "utf8");
        return content.split("\n").filter(Boolean).length === 2 ? content : undefined;
      });
      expect(finalMarker.split("\n").filter(Boolean)).toEqual([
        "wake_message-target-2",
        "wake_message-target-1"
      ]);

      const { stdout: attemptedJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--event",
        "message-target-2",
        "--json"
      ], { cwd: process.cwd() });
      const attempted = JSON.parse(attemptedJson) as Record<string, unknown>;
      expect(attempted.reason).toBe("already_attempted");
      expect(attempted.commandStarted).toBe(false);
      expect(attempted.target).toBe("message-target-2");

      const { stdout: missingJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--event",
        "missing-event",
        "--json"
      ], { cwd: process.cwd() });
      const missing = JSON.parse(missingJson) as Record<string, unknown>;
      expect(missing.reason).toBe("not_found");
      expect(missing.commandStarted).toBe(false);
      expect(missing.target).toBe("missing-event");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports pending wake command events in wake and main status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-status-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const marker = path.join(root, "status-marker.txt");
      const script = path.join(root, "wake-status-script.mjs");
      await writeFile(script, [
        "import { appendFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "await appendFile(marker, `${process.env.CODEX_COMS_WAKE_EVENT_ID}\\n`);"
      ].join("\n"), "utf8");

      await dispatchWakeEvent({
        dataDir: config.dataDir,
        workspace,
        localAgentId: "bob",
        entry: {
          id: "message-status-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "wake status should show trigger readiness",
          actionHint: "Inspect status before triggering.",
          read: false,
          payload: { text: "wake status should show trigger readiness" }
        }
      });

      const { stdout: initialWakeStatusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "status"
      ], { cwd: process.cwd() });
      const initialWakeStatus = JSON.parse(initialWakeStatusJson) as Record<string, unknown>;
      expect(initialWakeStatus.pendingWakeEvents).toBe(1);
      expect(initialWakeStatus.pendingWakeCommandEvents).toBe(1);
      expect(initialWakeStatus.attemptedWakeCommandEvents).toBe(0);
      expect(initialWakeStatus.wakeCommandRunning).toBe(false);

      await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "command",
        process.execPath,
        script,
        marker
      ], { cwd: process.cwd() });
      await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "trigger",
        "--json"
      ], { cwd: process.cwd() });

      const { stdout: afterWakeStatusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "status"
      ], { cwd: process.cwd() });
      const afterWakeStatus = JSON.parse(afterWakeStatusJson) as Record<string, unknown>;
      expect(afterWakeStatus.pendingWakeEvents).toBe(1);
      expect(afterWakeStatus.pendingWakeCommandEvents).toBe(0);
      expect(afterWakeStatus.attemptedWakeCommandEvents).toBe(1);

      const { stdout: mainStatusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "status",
        "--json"
      ], { cwd: process.cwd() });
      const mainStatus = JSON.parse(mainStatusJson) as Record<string, unknown>;
      expect(mainStatus.pendingWakeEvents).toBe(1);
      expect(mainStatus.pendingWakeCommandEvents).toBe(0);
      expect(mainStatus.attemptedWakeCommandEvents).toBe(1);
      expect(mainStatus.wakeCommandRunning).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports stale wake command locks without removing them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-stale-status-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "bob",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const lockPath = path.join(config.dataDir, "wake-command.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "pid"), "99999999\n", "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      const { stdout: wakeStatusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "wake",
        "status"
      ], { cwd: process.cwd() });
      const wakeStatus = JSON.parse(wakeStatusJson) as Record<string, unknown>;
      expect(wakeStatus.wakeCommandLockPresent).toBe(true);
      expect(wakeStatus.wakeCommandLockStale).toBe(true);
      expect(wakeStatus.wakeCommandRunning).toBe(false);
      expect(wakeStatus.wakeCommandPid).toBe(99999999);
      expect(typeof wakeStatus.wakeCommandLockAgeMs).toBe("number");
      await expect(readFile(path.join(lockPath, "pid"), "utf8")).resolves.toBe("99999999\n");

      const { stdout: mainStatusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "status",
        "--json"
      ], { cwd: process.cwd() });
      const mainStatus = JSON.parse(mainStatusJson) as Record<string, unknown>;
      expect(mainStatus.wakeCommandLockPresent).toBe(true);
      expect(mainStatus.wakeCommandLockStale).toBe(true);
      expect(mainStatus.wakeCommandRunning).toBe(false);

      const { stdout: mainStatusText } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "--workspace",
        workspace,
        "status"
      ], { cwd: process.cwd() });
      expect(mainStatusText).toContain("wake command lock: stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces wake command starts behind a live handler", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-command-coalesce-"));
    const release = path.join(root, "release");
    try {
      const dataDir = path.join(root, ".codex-coms");
      const marker = path.join(root, "marker.txt");
      const script = path.join(root, "wake-script.mjs");
      await writeFile(script, [
        "import { access, appendFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "const release = process.argv[3];",
        "await appendFile(marker, 'start\\n');",
        "while (true) {",
        "  try {",
        "    await access(release);",
        "    break;",
        "  } catch {",
        "    await new Promise((resolve) => setTimeout(resolve, 25));",
        "  }",
        "}"
      ].join("\n"), "utf8");
      const entry = (id: string) => ({
        id,
        timestamp: new Date().toISOString(),
        from: "alice",
        type: "agent.message",
        summary: `message ${id}`,
        actionHint: "reply when ready",
        read: false,
        payload: { text: `message ${id}` }
      });
      const command = [process.execPath, script, marker, release];
      const markerStarts = async (): Promise<number | undefined> => {
        try {
          return (await readFile(marker, "utf8")).split("\n").filter(Boolean).length;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      };

      const first = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-coalesce-1"),
        config: { enabled: true, command }
      });
      expect(first.commandStarted).toBe(true);
      await waitFor(async () => (await markerStarts()) === 1 ? 1 : undefined);

      const second = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-coalesce-2"),
        config: { enabled: true, command }
      });
      expect(second.commandStarted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await markerStarts()).toBe(1);
      expect((await readPendingWakeEvents(dataDir)).map((event) => event.inboxEntryId)).toEqual([
        "message-coalesce-1",
        "message-coalesce-2"
      ]);

      await writeFile(release, "done\n", "utf8");
      await waitFor(async () => {
        try {
          await readFile(path.join(dataDir, "wake-command.lock", "pid"), "utf8");
          return undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return true;
          }
          throw error;
        }
      });

      const third = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-coalesce-3"),
        config: { enabled: true, command }
      });
      expect(third.commandStarted).toBe(true);
      await waitFor(async () => (await markerStarts()) === 2 ? 2 : undefined);
    } finally {
      await writeFile(release, "done\n", "utf8").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a catch-up wake command for a coalesced pending event after the handler exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-command-catch-up-"));
    const release = path.join(root, "release");
    try {
      const dataDir = path.join(root, ".codex-coms");
      const marker = path.join(root, "marker.jsonl");
      const script = path.join(root, "wake-script.mjs");
      await writeFile(script, [
        "import { access, appendFile, readFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "const release = process.argv[3];",
        "const eventPath = process.argv[4];",
        "const event = JSON.parse(await readFile(eventPath, 'utf8'));",
        "await appendFile(marker, `${event.inboxEntryId}\\n`);",
        "if (event.inboxEntryId === 'message-catch-up-1') {",
        "  while (true) {",
        "    try {",
        "      await access(release);",
        "      break;",
        "    } catch {",
        "      await new Promise((resolve) => setTimeout(resolve, 25));",
        "    }",
        "  }",
        "}"
      ].join("\n"), "utf8");
      const entry = (id: string) => ({
        id,
        timestamp: new Date().toISOString(),
        from: "alice",
        type: "agent.message",
        summary: `message ${id}`,
        actionHint: "reply when ready",
        read: false,
        payload: { text: `message ${id}` }
      });
      const command = [process.execPath, script, marker, release];
      const markerEntries = async (): Promise<string[] | undefined> => {
        try {
          return (await readFile(marker, "utf8")).split("\n").filter(Boolean);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      };

      const first = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-catch-up-1"),
        config: { enabled: true, command }
      });
      expect(first.commandStarted).toBe(true);
      await waitFor(async () => (await markerEntries())?.join(",") === "message-catch-up-1" ? true : undefined);

      const second = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-catch-up-2"),
        config: { enabled: true, command }
      });
      expect(second.commandStarted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await markerEntries()).toEqual(["message-catch-up-1"]);

      await writeFile(release, "done\n", "utf8");
      await waitFor(async () => {
        const entries = await markerEntries();
        return entries?.join(",") === "message-catch-up-1,message-catch-up-2" ? entries : undefined;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await markerEntries()).toEqual(["message-catch-up-1", "message-catch-up-2"]);
      expect((await readPendingWakeEvents(dataDir)).map((event) => event.inboxEntryId)).toEqual([
        "message-catch-up-1",
        "message-catch-up-2"
      ]);
    } finally {
      await writeFile(release, "done\n", "utf8").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows concurrent wake commands when configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-command-concurrent-"));
    const release = path.join(root, "release");
    try {
      const dataDir = path.join(root, ".codex-coms");
      const marker = path.join(root, "marker.txt");
      const script = path.join(root, "wake-script.mjs");
      await writeFile(script, [
        "import { access, appendFile } from 'node:fs/promises';",
        "const marker = process.argv[2];",
        "const release = process.argv[3];",
        "await appendFile(marker, 'start\\n');",
        "while (true) {",
        "  try {",
        "    await access(release);",
        "    break;",
        "  } catch {",
        "    await new Promise((resolve) => setTimeout(resolve, 25));",
        "  }",
        "}"
      ].join("\n"), "utf8");
      const entry = (id: string) => ({
        id,
        timestamp: new Date().toISOString(),
        from: "alice",
        type: "agent.message",
        summary: `message ${id}`,
        actionHint: "reply when ready",
        read: false,
        payload: { text: `message ${id}` }
      });
      const config = {
        enabled: true,
        command: [process.execPath, script, marker, release],
        allowConcurrent: true
      };

      await expect(dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-concurrent-1"),
        config
      })).resolves.toMatchObject({ commandStarted: true });
      await expect(dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-concurrent-2"),
        config
      })).resolves.toMatchObject({ commandStarted: true });

      await waitFor(async () => {
        try {
          const starts = (await readFile(marker, "utf8")).split("\n").filter(Boolean).length;
          return starts === 2 ? starts : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      });
    } finally {
      await writeFile(release, "done\n", "utf8").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a stale wake command lock owned by a dead process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-command-dead-lock-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      const marker = path.join(root, "marker.txt");
      const script = path.join(root, "wake-script.mjs");
      const lockPath = path.join(dataDir, "wake-command.lock");
      await writeFile(script, [
        "import { writeFile } from 'node:fs/promises';",
        "await writeFile(process.argv[2], 'started\\n');"
      ].join("\n"), "utf8");
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "pid"), "99999999\n", "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      const result = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: {
          id: "message-command-dead-lock-1",
          timestamp: new Date().toISOString(),
          from: "alice",
          type: "agent.message",
          summary: "wake command should reclaim dead lock",
          actionHint: "reply when ready",
          read: false,
          payload: { text: "wake command should reclaim dead lock" }
        },
        config: {
          enabled: true,
          command: [process.execPath, script, marker]
        }
      });

      expect(result.commandStarted).toBe(true);
      await waitFor(async () => {
        try {
          return await readFile(marker, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      });
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

  it("writes event-specific inbox summaries for wake adapters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-wake-summary-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      const entry = (id: string, summary: string) => ({
        id,
        timestamp: new Date().toISOString(),
        from: "alice",
        type: "agent.message",
        summary,
        actionHint: "reply when ready",
        read: false,
        payload: { text: summary }
      });

      const first = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-summary-1", "first wake summary")
      });
      const second = await dispatchWakeEvent({
        dataDir,
        workspace: root,
        localAgentId: "bob",
        entry: entry("message-summary-2", "second wake summary")
      });

      expect(first.inboxSummaryPath).not.toBe(second.inboxSummaryPath);
      await expect(readFile(first.inboxSummaryPath, "utf8")).resolves.toContain("first wake summary");
      await expect(readFile(first.inboxSummaryPath, "utf8")).resolves.not.toContain("second wake summary");
      await expect(readFile(second.inboxSummaryPath, "utf8")).resolves.toContain("second wake summary");
      await expect(readFile(path.join(dataDir, "wake", "inbox-summary.txt"), "utf8")).resolves.toContain("second wake summary");
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
