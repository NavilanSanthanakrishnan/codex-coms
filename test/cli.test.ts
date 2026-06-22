import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initWorkspace, setRuntimeStatus } from "../src/config.js";
import { appendOutboxEntry } from "../src/peer/inbox.js";

const execFileAsync = promisify(execFile);
const cliArgs = ["--import", "tsx", "src/cli.ts"];

describe("CLI", () => {
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
