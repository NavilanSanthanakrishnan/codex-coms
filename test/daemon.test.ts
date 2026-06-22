import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initWorkspace, loadRuntimeStatus } from "../src/config.js";
import { sendAgentMessage } from "../src/peer/client.js";
import { readInboxEntries } from "../src/peer/inbox.js";
import { isProcessRunning, readSidecarPid } from "../src/peer/pid.js";
import { RelayServer } from "../src/relay/server.js";

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

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("could not allocate test port");
  }
  return address.port;
}

describe("sidecar daemon", () => {
  it("starts in the background from saved config without token args", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-daemon-"));
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
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        ...cliArgs,
        "connect",
        "--daemon",
        "--workspace",
        bobWorkspace
      ], { cwd: process.cwd() });
      expect(stdout).toContain("started sidecar daemon pid");
      const pid = await waitFor(async () => {
        const value = await readSidecarPid(bob.dataDir);
        return value && isProcessRunning(value) ? value : undefined;
      });
      const { stdout: commandLine } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
      expect(commandLine).not.toContain("test-token");
      await waitFor(async () => {
        const status = await loadRuntimeStatus(bob.dataDir);
        return status.connected && status.pid === pid ? status : undefined;
      });
      await sendAgentMessage(alice, "bob", "hello daemon");
      const inbox = await waitFor(async () => {
        const entries = await readInboxEntries(bob.dataDir);
        return entries.find((entry) => entry.summary.includes("hello daemon")) ? entries : undefined;
      });
      expect(inbox).toHaveLength(1);

      await execFileAsync(process.execPath, [
        ...cliArgs,
        "disconnect",
        "--workspace",
        bobWorkspace
      ], { cwd: process.cwd() });
      await waitFor(async () => {
        const status = await loadRuntimeStatus(bob.dataDir);
        return !status.connected ? status : undefined;
      });
    } finally {
      const pid = await readSidecarPid(bob.dataDir);
      if (pid && isProcessRunning(pid)) {
        process.kill(pid, "SIGTERM");
      }
      await relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps retrying until the relay becomes available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-daemon-retry-"));
    const port = await unusedPort();
    let relay: RelayServer | undefined;
    const aliceWorkspace = path.join(root, "alice");
    const bobWorkspace = path.join(root, "bob");
    await mkdir(aliceWorkspace, { recursive: true });
    await mkdir(bobWorkspace, { recursive: true });
    const relayUrl = `ws://127.0.0.1:${port}`;
    const alice = await initWorkspace({
      agentId: "alice",
      workspace: aliceWorkspace,
      relay: relayUrl,
      room: "pair",
      token: "test-token"
    });
    const bob = await initWorkspace({
      agentId: "bob",
      workspace: bobWorkspace,
      relay: relayUrl,
      room: "pair",
      token: "test-token"
    });
    try {
      await execFileAsync(process.execPath, [
        ...cliArgs,
        "connect",
        "--daemon",
        "--workspace",
        bobWorkspace,
        "--retry-delay-ms",
        "100"
      ], { cwd: process.cwd() });
      const pid = await waitFor(async () => {
        const value = await readSidecarPid(bob.dataDir);
        return value && isProcessRunning(value) ? value : undefined;
      });
      const beforeRelay = await loadRuntimeStatus(bob.dataDir);
      expect(beforeRelay.connected).toBe(false);

      relay = new RelayServer({
        host: "127.0.0.1",
        port,
        token: "test-token"
      });
      await relay.start();
      await waitFor(async () => {
        const status = await loadRuntimeStatus(bob.dataDir);
        return status.connected && status.pid === pid ? status : undefined;
      }, 8000);
      await sendAgentMessage(alice, "bob", "hello after retry");
      const inbox = await waitFor(async () => {
        const entries = await readInboxEntries(bob.dataDir);
        return entries.find((entry) => entry.summary.includes("hello after retry")) ? entries : undefined;
      });
      expect(inbox).toHaveLength(1);

      await execFileAsync(process.execPath, [
        ...cliArgs,
        "disconnect",
        "--workspace",
        bobWorkspace
      ], { cwd: process.cwd() });
      await waitFor(async () => {
        const status = await loadRuntimeStatus(bob.dataDir);
        return !status.connected ? status : undefined;
      });
    } finally {
      const pid = await readSidecarPid(bob.dataDir);
      if (pid && isProcessRunning(pid)) {
        process.kill(pid, "SIGTERM");
      }
      await relay?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
