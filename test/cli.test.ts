import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initWorkspace, setRuntimeStatus } from "../src/config.js";
import { PeerSidecar } from "../src/peer/client.js";
import { appendOutboxEntry, readInboxEntries, readOutboxEntries } from "../src/peer/inbox.js";
import { RelayServer } from "../src/relay/server.js";

const execFileAsync = promisify(execFile);
const cliArgs = ["--import", "tsx", "src/cli.ts"];

describe("CLI", () => {
  it("waits for the target sidecar before sending when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-cli-wait-send-"));
    const relay = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const started = await relay.start();
    let bobSidecar: PeerSidecar | undefined;
    let startError: unknown;
    let startTimer: NodeJS.Timeout | undefined;
    try {
      const aliceWorkspace = path.join(root, "alice");
      const bobWorkspace = path.join(root, "bob");
      await mkdir(aliceWorkspace, { recursive: true });
      await mkdir(bobWorkspace, { recursive: true });
      const aliceConfig = await initWorkspace({
        agentId: "alice",
        workspace: aliceWorkspace,
        relay: started.url,
        room: "pair",
        token: "test-token"
      });
      const bobConfig = await initWorkspace({
        agentId: "bob",
        workspace: bobWorkspace,
        relay: started.url,
        room: "pair",
        token: "test-token"
      });

      startTimer = setTimeout(() => {
        bobSidecar = new PeerSidecar(bobConfig);
        bobSidecar.start().catch((error) => {
          startError = error;
        });
      }, 100);

      const { stdout } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "send",
        "--workspace",
        aliceWorkspace,
        "--to",
        "bob",
        "--text",
        "hello after wait",
        "--wait-ms",
        "2000"
      ], { cwd: process.cwd() });

      if (startError) {
        throw startError;
      }
      expect(stdout).toContain("sent ");
      const inbox = await readInboxEntries(bobConfig.dataDir);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toEqual(expect.objectContaining({
        from: "alice",
        type: "agent.message",
        summary: "hello after wait"
      }));
      const outbox = await readOutboxEntries(aliceConfig.dataDir);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toEqual(expect.objectContaining({
        to: "bob",
        type: "agent.message",
        delivered: true
      }));
    } finally {
      if (startTimer) {
        clearTimeout(startTimer);
      }
      await bobSidecar?.stop().catch(() => undefined);
      await relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows failed outbox records and status summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-cli-outbox-"));
    try {
      const workspace = path.join(root, "alice");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "alice",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      await appendOutboxEntry(config.dataDir, {
        id: "message-ok",
        to: "bob",
        type: "agent.message",
        summary: "delivered note",
        delivered: true
      });
      await appendOutboxEntry(config.dataDir, {
        id: "message-failed",
        to: "bob",
        type: "agent.message",
        summary: "failed note",
        delivered: false,
        error: "target bob is not connected"
      });

      const { stdout: outboxJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "outbox",
        "--workspace",
        workspace,
        "--failed",
        "--json"
      ], { cwd: process.cwd() });
      const failed = JSON.parse(outboxJson) as Array<Record<string, unknown>>;
      expect(failed).toHaveLength(1);
      expect(failed[0]).toEqual(expect.objectContaining({
        id: "message-failed",
        to: "bob",
        delivered: false,
        error: "target bob is not connected"
      }));

      const { stdout: statusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "status",
        "--workspace",
        workspace,
        "--json"
      ], { cwd: process.cwd() });
      const status = JSON.parse(statusJson) as Record<string, unknown>;
      expect(status.outboxFailedCount).toBe(1);
      expect(status.lastFailedSend).toEqual(expect.objectContaining({
        id: "message-failed",
        to: "bob",
        error: "target bob is not connected"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows runtime connection timestamps in status output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-cli-status-time-"));
    try {
      const workspace = path.join(root, "alice");
      await mkdir(workspace, { recursive: true });
      const config = await initWorkspace({
        agentId: "alice",
        workspace,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        token: "test-token"
      });
      const connectedAt = "2026-06-22T16:00:00.000Z";
      const disconnectedAt = "2026-06-22T16:05:00.000Z";
      await setRuntimeStatus(config.dataDir, {
        connected: false,
        agentId: "alice",
        pid: 12345,
        relay: "ws://127.0.0.1:8787",
        room: "pair",
        connectedAt,
        disconnectedAt
      });

      const { stdout: statusJson } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "status",
        "--workspace",
        workspace,
        "--json"
      ], { cwd: process.cwd() });
      const status = JSON.parse(statusJson) as Record<string, unknown>;
      expect(status.connectedAt).toBe(connectedAt);
      expect(status.disconnectedAt).toBe(disconnectedAt);

      const { stdout: statusText } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "status",
        "--workspace",
        workspace
      ], { cwd: process.cwd() });
      expect(statusText).toContain(`connected at: ${connectedAt}`);
      expect(statusText).toContain(`disconnected at: ${disconnectedAt}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
