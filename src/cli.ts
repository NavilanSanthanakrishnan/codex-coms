#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { appendAudit } from "./audit/auditLog.js";
import {
  DEFAULT_ROOM,
  initWorkspace,
  loadConfig,
  loadRuntimeStatus,
  resolveDataDir,
  resolveWorkspace,
  saveConfig,
  updateConfig,
  validateAgentId,
  type CodexComsConfig
} from "./config.js";
import { runDemo } from "./demo/runDemo.js";
import { PeerSidecar, parseListResponse, parseReadResponse, requestProtocolResponse, requestRoomPeers, sendAgentMessage, sendFileToPeer, sendProtocolMessage } from "./peer/client.js";
import { formatInbox, formatOutbox, markInboxRead, readInboxEntries, readOutboxEntries } from "./peer/inbox.js";
import { clearSidecarPid, ensureNoDuplicateSidecar, isProcessRunning, readSidecarPid, writeSidecarPid } from "./peer/pid.js";
import { makeProtocolMessage } from "./protocol/schema.js";
import { RelayServer } from "./relay/server.js";
import { createGrant, isGrantActive, loadGrants, revokeGrant } from "./workspace/grants.js";
import { drainPendingWakeEvents, drainWakeEventsForInboxEntries, formatWakeEvents, readPendingWakeEvents, readWakeEvents, triggerPendingWakeCommand, waitForPendingWakeEvents } from "./wake/codexWake.js";
import path from "node:path";

const program = new Command();

program
  .name("codex-coms")
  .description("Skills-first communication layer for Codex agents")
  .option("--workspace <path>", "workspace path", process.cwd())
  .option("--data-dir <path>", "state directory, defaults to .codex-coms inside the workspace");

function workspaceFromOptions(options: Record<string, unknown>): string {
  return resolveWorkspace(String(options.workspace ?? program.opts().workspace ?? process.cwd()));
}

function dataDirFromOptions(workspace: string, options: Record<string, unknown>): string {
  const value = options.dataDir ?? program.opts().dataDir;
  return resolveDataDir(workspace, typeof value === "string" ? value : undefined);
}

async function loadCliConfig(options: Record<string, unknown>): Promise<CodexComsConfig> {
  const workspace = workspaceFromOptions(options);
  const dataDir = dataDirFromOptions(workspace, options);
  return loadConfig(workspace, dataDir);
}

function positiveIntegerOption(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeIntegerOption(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveConnectConfig(options: Record<string, unknown>): Promise<CodexComsConfig> {
  const workspace = workspaceFromOptions(options);
  const dataDir = dataDirFromOptions(workspace, options);
  let existing: Partial<CodexComsConfig> = {};
  try {
    existing = await loadConfig(workspace, dataDir);
  } catch {
    existing = {};
  }
  const agentId = typeof options.agent === "string" ? options.agent : existing.agentId;
  const relay = typeof options.relay === "string" ? options.relay : existing.relay;
  const room = typeof options.room === "string" ? options.room : existing.room ?? DEFAULT_ROOM;
  const token = typeof options.token === "string" ? options.token : existing.token;
  if (!agentId || !relay || !room || !token) {
    throw new Error("connect needs agent, relay, room, and token; pass them once or run codex-coms init first");
  }
  validateAgentId(agentId);
  const patch = {
    agentId,
    relay,
    room,
    token,
    workspace,
    dataDir
  };
  if (existing.agentId) {
    return updateConfig(existing as CodexComsConfig, patch);
  }
  return initWorkspace(patch);
}

async function startDaemonSidecar(config: CodexComsConfig, options: Record<string, unknown>): Promise<void> {
  await ensureNoDuplicateSidecar(config.dataDir, Boolean(options.replace));
  const logPath = path.resolve(config.dataDir, typeof options.log === "string" ? options.log : "sidecar.log");
  const retryDelayMs = positiveIntegerOption(options.retryDelayMs ?? 1000, "--retry-delay-ms");
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, "a");
  try {
    const child = spawn(process.execPath, [
      ...process.execArgv,
      process.argv[1] ?? path.resolve("dist/src/cli.js"),
      "connect",
      "--workspace",
      config.workspace,
      "--data-dir",
      config.dataDir,
      "--retry",
      "--retry-delay-ms",
      String(retryDelayMs)
    ], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd]
    });
    if (!child.pid) {
      throw new Error("failed to start daemon sidecar");
    }
    await writeSidecarPid(config.dataDir, child.pid);
    child.unref();
    console.log(`started sidecar daemon pid ${child.pid}`);
    console.log(`log: ${logPath}`);
  } finally {
    await log.close();
  }
}

async function runSidecar(config: CodexComsConfig, options: { retry: boolean; retryDelayMs: number }): Promise<void> {
  let sidecar: PeerSidecar | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await sidecar?.stop();
    } finally {
      await clearSidecarPid(config.dataDir);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    sidecar = new PeerSidecar(config);
    let connected = false;
    try {
      await sidecar.start();
      connected = true;
      await writeSidecarPid(config.dataDir);
      console.log(`connected ${config.agentId} to ${config.relay} room=${config.room}`);
      await sidecar.waitForClose();
      if (options.retry && !stopping) {
        console.error(`sidecar disconnected; retrying in ${options.retryDelayMs}ms`);
      }
    } catch (error) {
      await appendAudit(config.dataDir, {
        event: "sidecar_connect_failed",
        actor: config.agentId,
        result: "error",
        details: { relay: config.relay, room: config.room, reason: (error as Error).message }
      });
      if (!options.retry || stopping) {
        throw error;
      }
      console.error(`sidecar connection failed: ${(error as Error).message}; retrying in ${options.retryDelayMs}ms`);
    } finally {
      sidecar = undefined;
      if ((!options.retry || stopping) && connected) {
        await clearSidecarPid(config.dataDir);
      }
    }
    if (options.retry && !stopping) {
      await sleep(options.retryDelayMs);
    }
  } while (options.retry && !stopping);
}

program.command("relay")
  .description("start the WebSocket relay")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .requiredOption("--token <token>", "shared room token")
  .action(async (options) => {
    const relay = new RelayServer({
      host: options.host,
      port: Number(options.port),
      token: options.token,
      logger: console
    });
    await relay.start();
    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });
    await relay.stop();
  });

program.command("init")
  .description("initialize codex-coms state in a workspace")
  .requiredOption("--agent <agentId>", "local agent id")
  .option("--workspace <path>", "workspace path")
  .option("--data-dir <path>", "state directory")
  .option("--relay <url>", "relay WebSocket URL")
  .option("--room <room>", "room name", DEFAULT_ROOM)
  .option("--token <token>", "shared room token")
  .option("--display-name <name>", "friendly display name; wire agent ids cannot contain spaces")
  .action(async (options) => {
    const config = await initWorkspace({
      agentId: options.agent,
      displayName: options.displayName,
      workspace: options.workspace ?? program.opts().workspace,
      dataDir: options.dataDir ?? program.opts().dataDir,
      relay: options.relay,
      room: options.room,
      token: options.token
    });
    console.log(`initialized ${config.agentId} at ${config.dataDir}`);
  });

program.command("connect")
  .description("start the local sidecar and connect it to the relay")
  .option("--relay <url>", "relay WebSocket URL")
  .option("--room <room>", "room name")
  .option("--agent <agentId>", "local agent id")
  .option("--token <token>", "shared room token")
  .option("--workspace <path>", "workspace path")
  .option("--data-dir <path>", "state directory")
  .option("--replace", "stop an existing sidecar for this workspace before connecting")
  .option("--daemon", "start the sidecar in the background using saved config")
  .option("--log <path>", "daemon log path, defaults to .codex-coms/sidecar.log")
  .option("--retry", "keep reconnecting after disconnects or connection failures")
  .option("--retry-delay-ms <ms>", "delay between retry attempts", "1000")
  .action(async (options) => {
    const config = await resolveConnectConfig(options);
    if (options.daemon) {
      await startDaemonSidecar(config, options);
      return;
    }
    await ensureNoDuplicateSidecar(config.dataDir, Boolean(options.replace));
    await runSidecar(config, {
      retry: Boolean(options.retry),
      retryDelayMs: positiveIntegerOption(options.retryDelayMs, "--retry-delay-ms")
    });
  });

program.command("disconnect")
  .description("stop the sidecar process recorded for this workspace")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const pid = await readSidecarPid(config.dataDir);
    if (!pid) {
      console.log("no sidecar pid file found");
      return;
    }
    if (!isProcessRunning(pid)) {
      await clearSidecarPid(config.dataDir, pid);
      console.log(`removed stale sidecar pid ${pid}`);
      return;
    }
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to sidecar pid ${pid}`);
  });

program.command("rename")
  .description("rename the local wire agent id in config; stop the sidecar first")
  .requiredOption("--agent <agentId>", "new wire agent id, such as shreyagent")
  .option("--display-name <name>", "friendly display name, such as Shrey Agent")
  .action(async (options) => {
    validateAgentId(options.agent);
    const config = await loadCliConfig(options);
    const pid = await readSidecarPid(config.dataDir);
    if (pid && isProcessRunning(pid)) {
      throw new Error(`sidecar pid ${pid} is still running; run codex-coms disconnect first, then reconnect with --agent ${options.agent}`);
    }
    const next = await updateConfig(config, {
      agentId: options.agent,
      displayName: options.displayName ?? config.displayName
    });
    console.log(`renamed local agent id to ${next.agentId}`);
    if (next.displayName) {
      console.log(`display name: ${next.displayName}`);
    }
  });

program.command("send")
  .description("send a message to a peer agent")
  .requiredOption("--to <agentId>", "target agent id")
  .requiredOption("--text <message>", "message text")
  .action(async (options) => {
    validateAgentId(options.to);
    const config = await loadCliConfig(options);
    const message = await sendAgentMessage(config, options.to, options.text);
    console.log(`sent ${message.id} to ${options.to}`);
  });

program.command("inbox")
  .description("print unread inbox entries")
  .option("--json", "print JSON")
  .option("--mark-read", "mark displayed entries as read")
  .option("--all", "include read entries")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const entries = await readInboxEntries(config.dataDir);
    const displayed = options.all ? entries : entries.filter((entry) => !entry.read);
    if (options.json) {
      console.log(JSON.stringify(displayed, null, 2));
    } else {
      console.log(formatInbox(displayed));
    }
    if (options.markRead) {
      const displayedIds = displayed.map((entry) => entry.id);
      const drainedWakeEvents = await drainWakeEventsForInboxEntries(config.dataDir, displayedIds);
      const changed = await markInboxRead(config.dataDir, displayedIds);
      if (!options.json) {
        console.log(`Marked ${changed} message(s) read.`);
        console.log(`Drained ${drainedWakeEvents} wake event(s).`);
      }
    }
  });

program.command("outbox")
  .description("print outbound message records")
  .option("--json", "print JSON")
  .option("--failed", "show only failed sends")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const entries = await readOutboxEntries(config.dataDir);
    const displayed = options.failed ? entries.filter((entry) => !entry.delivered) : entries;
    if (options.json) {
      console.log(JSON.stringify(displayed, null, 2));
    } else {
      console.log(formatOutbox(displayed));
    }
  });

program.command("grant")
  .description("grant read-only access to a local file or directory")
  .requiredOption("--to <agentId>", "target agent id")
  .requiredOption("--path <path>", "workspace file or directory to grant")
  .requiredOption("--name <grantName>", "human-readable grant name")
  .option("--ttl <ttl>", "time to live, such as 30m, 2h, or 1d", "2h")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const grant = await createGrant({
      dataDir: config.dataDir,
      workspace: config.workspace,
      ownerAgentId: config.agentId,
      targetAgentId: options.to,
      grantPath: options.path,
      name: options.name,
      ttl: options.ttl
    });
    await appendAudit(config.dataDir, {
      event: "grant_created",
      actor: config.agentId,
      peer: options.to,
      result: "ok",
      details: { grantId: grant.id, path: grant.path, expiresAt: grant.expiresAt }
    });
    const notice = makeProtocolMessage({
      type: "workspace.grant.created",
      room: config.room ?? DEFAULT_ROOM,
      from: config.agentId,
      to: options.to,
      payload: {
        grantId: grant.id,
        name: grant.name,
        path: grant.path,
        expiresAt: grant.expiresAt,
        maxReadBytes: grant.maxReadBytes,
        maxListEntries: grant.maxListEntries
      }
    });
    try {
      await sendProtocolMessage(config, notice);
    } catch (error) {
      console.warn(`grant created locally, but notice was not delivered: ${(error as Error).message}`);
    }
    console.log(`grant ${grant.id} created for ${options.to} until ${grant.expiresAt}`);
  });

program.command("revoke")
  .description("revoke a grant")
  .requiredOption("--grant <grantId>", "grant id")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const grant = await revokeGrant(config.dataDir, options.grant);
    if (!grant) {
      throw new Error(`grant ${options.grant} not found`);
    }
    await appendAudit(config.dataDir, {
      event: "grant_revoked",
      actor: config.agentId,
      peer: grant.targetAgentId,
      result: "ok",
      details: { grantId: grant.id }
    });
    const notice = makeProtocolMessage({
      type: "workspace.grant.revoked",
      room: config.room ?? DEFAULT_ROOM,
      from: config.agentId,
      to: grant.targetAgentId,
      payload: {
        grantId: grant.id
      }
    });
    try {
      await sendProtocolMessage(config, notice);
    } catch (error) {
      console.warn(`grant revoked locally, but notice was not delivered: ${(error as Error).message}`);
    }
    console.log(`grant ${grant.id} revoked`);
  });

program.command("request-read")
  .description("ask a peer to grant read-only access")
  .requiredOption("--to <agentId>", "target agent id")
  .requiredOption("--path <path>", "path being requested")
  .requiredOption("--reason <reason>", "why the access is needed")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const message = makeProtocolMessage({
      type: "workspace.grant.request",
      room: config.room ?? DEFAULT_ROOM,
      from: config.agentId,
      to: options.to,
      payload: {
        path: options.path,
        reason: options.reason
      }
    });
    await appendAudit(config.dataDir, {
      event: "grants_requested",
      actor: config.agentId,
      peer: options.to,
      messageId: message.id,
      result: "ok",
      details: { path: options.path }
    });
    await sendProtocolMessage(config, message);
    console.log(`requested read access from ${options.to}`);
  });

program.command("list-remote")
  .description("list files inside a remote grant")
  .requiredOption("--from <agentId>", "granting agent id")
  .requiredOption("--grant <grantId>", "grant id")
  .option("--path <relativePath>", "relative path inside grant", ".")
  .option("--json", "print JSON")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const message = makeProtocolMessage({
      type: "workspace.list.request",
      room: config.room ?? DEFAULT_ROOM,
      from: config.agentId,
      to: options.from,
      payload: {
        grantId: options.grant,
        path: options.path
      }
    });
    const response = parseListResponse(await requestProtocolResponse(config, message, ["workspace.list.response"]));
    if (!response.ok) {
      throw new Error(response.error);
    }
    if (options.json) {
      console.log(JSON.stringify(response.entries, null, 2));
    } else {
      for (const entry of response.entries) {
        const size = entry.size === undefined ? "" : ` ${entry.size}b`;
        console.log(`${entry.type.padEnd(9)} ${entry.path}${size}`);
      }
    }
  });

program.command("read-remote")
  .description("read a file through a remote grant")
  .requiredOption("--from <agentId>", "granting agent id")
  .requiredOption("--grant <grantId>", "grant id")
  .requiredOption("--path <relativePath>", "relative file path inside grant")
  .option("--json", "print JSON metadata and base64 content")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const message = makeProtocolMessage({
      type: "workspace.read.request",
      room: config.room ?? DEFAULT_ROOM,
      from: config.agentId,
      to: options.from,
      payload: {
        grantId: options.grant,
        path: options.path
      }
    });
    const response = parseReadResponse(await requestProtocolResponse(config, message, ["workspace.read.response"]));
    if (!response.ok) {
      throw new Error(response.error);
    }
    if (options.json) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      process.stdout.write(Buffer.from(response.contentBase64, "base64"));
    }
  });

program.command("send-file")
  .description("transfer a file to a peer")
  .requiredOption("--to <agentId>", "target agent id")
  .requiredOption("--path <path>", "local file path")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const filePath = path.isAbsolute(options.path) ? options.path : path.resolve(config.workspace, options.path);
    const transferId = await sendFileToPeer(config, options.to, filePath);
    console.log(`sent file transfer ${transferId} to ${options.to}`);
  });

program.command("status")
  .description("show local codex-coms state")
  .option("--json", "print JSON")
  .option("--peers", "ask the relay for connected peers in this room")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const inbox = await readInboxEntries(config.dataDir);
    const outbox = await readOutboxEntries(config.dataDir);
    const grants = await loadGrants(config.dataDir);
    const runtime = await loadRuntimeStatus(config.dataDir);
    const pendingWakeEvents = await readPendingWakeEvents(config.dataDir);
    const activeGrants = grants.filter((grant) => isGrantActive(grant));
    const sidecarPid = await readSidecarPid(config.dataDir);
    const sidecarPidRunning = sidecarPid ? isProcessRunning(sidecarPid) : false;
    const warnings: string[] = [];
    if (runtime.agentId && runtime.agentId !== config.agentId) {
      warnings.push(`identity drift: config agent is ${config.agentId}, last sidecar agent is ${runtime.agentId}`);
    }
    if (runtime.connected && !sidecarPidRunning) {
      warnings.push("status file says connected, but no recorded sidecar pid is running");
    }
    const failedOutbox = outbox.filter((entry) => !entry.delivered);
    const lastFailedSend = failedOutbox.at(-1);
    let peers: Array<{ agentId: string; sockets: number; kinds: string[] }> | undefined;
    if (options.peers) {
      try {
        peers = await requestRoomPeers(config);
      } catch (error) {
        warnings.push(`could not fetch peers: ${(error as Error).message}`);
      }
    }
    const status = {
      agentId: config.agentId,
      displayName: config.displayName,
      workspace: config.workspace,
      relay: config.relay,
      room: config.room,
      connected: runtime.connected,
      sidecarAgentId: runtime.agentId,
      connectedAt: runtime.connectedAt,
      disconnectedAt: runtime.disconnectedAt,
      sidecarPid,
      sidecarPidRunning,
      inboxCount: inbox.filter((entry) => !entry.read).length,
      outboxFailedCount: failedOutbox.length,
      lastFailedSend,
      pendingWakeEvents: pendingWakeEvents.length,
      activeGrants: activeGrants.length,
      transferFolder: path.join(config.dataDir, "transfers"),
      auditLogPath: path.join(config.dataDir, "audit.jsonl"),
      tokenConfigured: Boolean(config.token),
      wakeEnabled: Boolean(config.wake?.enabled),
      peers,
      warnings
    };
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`agent: ${status.agentId}`);
      if (status.displayName) {
        console.log(`display name: ${status.displayName}`);
      }
      console.log(`workspace: ${status.workspace}`);
      console.log(`relay: ${status.relay ?? "(not configured)"}`);
      console.log(`room: ${status.room ?? "(not configured)"}`);
      console.log(`connected: ${status.connected}`);
      if (status.connectedAt) {
        console.log(`connected at: ${status.connectedAt}`);
      }
      if (status.disconnectedAt) {
        console.log(`disconnected at: ${status.disconnectedAt}`);
      }
      console.log(`sidecar pid: ${status.sidecarPid ?? "(none)"}${status.sidecarPidRunning ? " running" : ""}`);
      if (status.sidecarAgentId) {
        console.log(`sidecar agent: ${status.sidecarAgentId}`);
      }
      console.log(`unread inbox: ${status.inboxCount}`);
      console.log(`failed outbox: ${status.outboxFailedCount}`);
      if (status.lastFailedSend) {
        console.log(`last failed send: ${status.lastFailedSend.timestamp} to ${status.lastFailedSend.to} (${status.lastFailedSend.error ?? "unknown error"})`);
      }
      console.log(`pending wake events: ${status.pendingWakeEvents}`);
      console.log(`active grants: ${status.activeGrants}`);
      console.log(`transfers: ${status.transferFolder}`);
      console.log(`audit: ${status.auditLogPath}`);
      console.log(`token configured: ${status.tokenConfigured}`);
      console.log(`wake enabled: ${status.wakeEnabled}`);
      if (status.peers) {
        console.log("peers:");
        for (const peer of status.peers) {
          console.log(`- ${peer.agentId} sockets=${peer.sockets} kinds=${peer.kinds.join(",")}`);
        }
      }
      for (const warning of status.warnings) {
        console.log(`warning: ${warning}`);
      }
    }
  });

const wake = program.command("wake")
  .description("configure local opt-in wake behavior for inbound inbox events");

wake.command("status")
  .description("show wake configuration")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const pending = await readPendingWakeEvents(config.dataDir);
    console.log(JSON.stringify({
      ...(config.wake ?? { enabled: false }),
      pendingWakeEvents: pending.length
    }, null, 2));
  });

wake.command("queue")
  .description("show pending local wake events without marking them handled")
  .option("--json", "print JSON")
  .option("--all", "include already drained wake events")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const events = options.all ? await readWakeEvents(config.dataDir) : await readPendingWakeEvents(config.dataDir);
    if (options.json) {
      console.log(JSON.stringify(events, null, 2));
    } else {
      console.log(formatWakeEvents(events));
    }
  });

wake.command("drain")
  .description("claim pending wake events for a local thread or automation")
  .option("--json", "print JSON")
  .option("--limit <count>", "maximum events to drain", "20")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("--limit must be a positive integer");
    }
    const events = await drainPendingWakeEvents(config.dataDir, limit);
    if (options.json) {
      console.log(JSON.stringify(events, null, 2));
    } else {
      console.log(formatWakeEvents(events));
      console.log(`Drained ${events.length} wake event(s).`);
    }
  });

wake.command("wait")
  .description("wait until local wake events are available, then claim them")
  .option("--json", "print JSON")
  .option("--limit <count>", "maximum events to drain", "1")
  .option("--timeout-ms <ms>", "maximum time to wait; 0 waits forever", "0")
  .option("--poll-ms <ms>", "fallback wake queue check interval", "250")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const events = await waitForPendingWakeEvents(config.dataDir, {
      limit: positiveIntegerOption(options.limit, "--limit"),
      timeoutMs: nonNegativeIntegerOption(options.timeoutMs, "--timeout-ms"),
      pollMs: positiveIntegerOption(options.pollMs, "--poll-ms")
    });
    if (options.json) {
      console.log(JSON.stringify(events, null, 2));
    } else if (events.length === 0) {
      console.log("No wake events arrived before timeout.");
    } else {
      console.log(formatWakeEvents(events));
      console.log(`Drained ${events.length} wake event(s).`);
    }
  });

wake.command("trigger")
  .description("start the configured wake command for the next pending unattempted wake event")
  .option("--json", "print JSON")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const result = await triggerPendingWakeCommand(config.dataDir, config.agentId, config.wake);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.reason === "not_configured") {
      console.log("No wake command is configured. Run codex-coms wake notify or codex-coms wake command first.");
    } else if (result.reason === "no_pending") {
      console.log("No pending wake events need a wake command.");
    } else if (result.reason === "already_attempted") {
      console.log("All pending wake events already attempted a wake command.");
    } else if (result.reason === "started") {
      console.log(`Started wake command for ${result.event?.id}.`);
    } else {
      console.log(`Wake command was not started for ${result.event?.id}; it may already be running or failed to spawn. Check the audit log.`);
    }
  });

wake.command("disable")
  .description("disable wake behavior")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    await updateConfig(config, {
      wake: { enabled: false }
    });
    console.log("wake disabled");
  });

wake.command("notify")
  .description("wake with a local macOS notification when inbox events arrive")
  .action(async (options) => {
    const config = await loadCliConfig(options);
    await updateConfig(config, {
      wake: {
        enabled: true,
        allowConcurrent: true,
        appendEventPath: false,
        command: [
          "/usr/bin/osascript",
          "-e",
          "display notification \"Run codex-coms inbox to read it.\" with title \"codex-coms message\""
        ]
      }
    });
    console.log("wake enabled with local macOS notification");
  });

wake.command("command")
  .description("wake with a locally chosen command; remote message text is never passed as shell input")
  .argument("<command>", "absolute command path")
  .argument("[args...]", "static command args")
  .option("--prompt <text>", "static prompt argument appended after static args")
  .option("--allow-concurrent", "start a new wake command for every event instead of coalescing behind a live handler")
  .option("--no-event-path", "do not append the local wake event JSON path as the final argument")
  .action(async (command, args: string[], options) => {
    const config = await loadCliConfig(options);
    if (!path.isAbsolute(command)) {
      throw new Error("wake command must be an absolute path");
    }
    await updateConfig(config, {
      wake: {
        enabled: true,
        command: [command, ...args],
        staticPrompt: options.prompt,
        allowConcurrent: Boolean(options.allowConcurrent),
        appendEventPath: options.eventPath
      }
    });
    console.log(`wake enabled with command ${command}`);
  });

program.command("demo")
  .description("run a local two-agent simulation")
  .action(async () => {
    const result = await runDemo();
    console.log("codex-coms demo complete");
    console.log(`root: ${result.root}`);
    console.log(`relay: ${result.relayUrl}`);
    console.log(`bob inbox entries: ${result.bobInboxCount}`);
    console.log(`grant: ${result.grantId}`);
    console.log(`remote read contains: ${result.remoteReadText.trim()}`);
    console.log(`outside read denied: ${result.outsideReadDenied}`);
    console.log(`transfer: ${result.transferId}`);
    console.log(`received file: ${result.transferredFile}`);
    console.log(`audit logs written: ${result.auditLogsWritten}`);
  });

program.parseAsync().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
