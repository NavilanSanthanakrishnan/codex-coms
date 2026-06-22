#!/usr/bin/env node
import { Command } from "commander";
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
  type CodexComsConfig
} from "./config.js";
import { runDemo } from "./demo/runDemo.js";
import { PeerSidecar, parseListResponse, parseReadResponse, requestProtocolResponse, sendAgentMessage, sendFileToPeer, sendProtocolMessage } from "./peer/client.js";
import { formatInbox, markInboxRead, readInboxEntries } from "./peer/inbox.js";
import { makeProtocolMessage } from "./protocol/schema.js";
import { RelayServer } from "./relay/server.js";
import { createGrant, isGrantActive, loadGrants, revokeGrant } from "./workspace/grants.js";
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
  .action(async (options) => {
    const config = await initWorkspace({
      agentId: options.agent,
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
  .requiredOption("--relay <url>", "relay WebSocket URL")
  .requiredOption("--room <room>", "room name")
  .requiredOption("--agent <agentId>", "local agent id")
  .requiredOption("--token <token>", "shared room token")
  .option("--workspace <path>", "workspace path")
  .option("--data-dir <path>", "state directory")
  .action(async (options) => {
    const workspace = workspaceFromOptions(options);
    const dataDir = dataDirFromOptions(workspace, options);
    let config: CodexComsConfig;
    try {
      config = await loadConfig(workspace, dataDir);
      config = await updateConfig(config, {
        agentId: options.agent,
        relay: options.relay,
        room: options.room,
        token: options.token,
        workspace,
        dataDir
      });
    } catch {
      config = await initWorkspace({
        agentId: options.agent,
        workspace,
        dataDir,
        relay: options.relay,
        room: options.room,
        token: options.token
      });
    }
    const sidecar = new PeerSidecar(config);
    let stopping = false;
    const stop = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      await sidecar.stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await sidecar.start();
    console.log(`connected ${config.agentId} to ${config.relay} room=${config.room}`);
    await sidecar.waitForClose();
  });

program.command("send")
  .description("send a message to a peer agent")
  .requiredOption("--to <agentId>", "target agent id")
  .requiredOption("--text <message>", "message text")
  .action(async (options) => {
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
      const changed = await markInboxRead(config.dataDir, displayed.map((entry) => entry.id));
      if (!options.json) {
        console.log(`Marked ${changed} message(s) read.`);
      }
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
  .action(async (options) => {
    const config = await loadCliConfig(options);
    const inbox = await readInboxEntries(config.dataDir);
    const grants = await loadGrants(config.dataDir);
    const runtime = await loadRuntimeStatus(config.dataDir);
    const activeGrants = grants.filter((grant) => isGrantActive(grant));
    const status = {
      agentId: config.agentId,
      workspace: config.workspace,
      relay: config.relay,
      room: config.room,
      connected: runtime.connected,
      inboxCount: inbox.filter((entry) => !entry.read).length,
      activeGrants: activeGrants.length,
      transferFolder: path.join(config.dataDir, "transfers"),
      auditLogPath: path.join(config.dataDir, "audit.jsonl"),
      tokenConfigured: Boolean(config.token)
    };
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`agent: ${status.agentId}`);
      console.log(`workspace: ${status.workspace}`);
      console.log(`relay: ${status.relay ?? "(not configured)"}`);
      console.log(`room: ${status.room ?? "(not configured)"}`);
      console.log(`connected: ${status.connected}`);
      console.log(`unread inbox: ${status.inboxCount}`);
      console.log(`active grants: ${status.activeGrants}`);
      console.log(`transfers: ${status.transferFolder}`);
      console.log(`audit: ${status.auditLogPath}`);
      console.log(`token configured: ${status.tokenConfigured}`);
    }
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
