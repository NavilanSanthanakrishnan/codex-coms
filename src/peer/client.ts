import WebSocket from "ws";
import { appendAudit } from "../audit/auditLog.js";
import { type CodexComsConfig, loadRuntimeStatus, setRuntimeStatus } from "../config.js";
import {
  FileAcceptPayloadSchema,
  FileChunkPayloadSchema,
  FileCompletePayloadSchema,
  FileOfferPayloadSchema,
  RoomPeersResponsePayloadSchema,
  WorkspaceGrantCreatedPayloadSchema,
  WorkspaceGrantRequestPayloadSchema,
  WorkspaceGrantRevokedPayloadSchema,
  WorkspaceListRequestPayloadSchema,
  WorkspaceListResponsePayloadSchema,
  WorkspaceReadRequestPayloadSchema,
  WorkspaceReadResponsePayloadSchema,
  makeProtocolMessage,
  parseProtocolMessage,
  validatePayload
} from "../protocol/schema.js";
import type { ProtocolMessage, ProtocolType } from "../protocol/types.js";
import { appendInboxEntry, appendOutboxEntry } from "./inbox.js";
import type { InboxEntry } from "./inbox.js";
import { FileTransferReceiver, prepareFileTransfer } from "../transfer/fileTransfer.js";
import { findUsableGrant } from "../workspace/grants.js";
import { FsAccessError, listGrantedPath, readGrantedFile } from "../workspace/fsAccess.js";
import { dispatchWakeEvent } from "../wake/codexWake.js";

export interface ProtocolConnectionOptions {
  relay: string;
  room: string;
  agentId: string;
  token: string;
  kind?: "sidecar" | "cli" | "relay-test";
}

interface ProtocolWaiter {
  filter: (message: ProtocolMessage) => boolean;
  resolve: (message: ProtocolMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ProtocolConnection {
  private readonly waiters = new Set<ProtocolWaiter>();
  private closed = false;

  private constructor(private readonly ws: WebSocket, private readonly options: ProtocolConnectionOptions) {}

  static async open(options: ProtocolConnectionOptions): Promise<ProtocolConnection> {
    const ws = new WebSocket(options.relay);
    const connection = new ProtocolConnection(ws, options);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.on("message", (data) => {
      let message: ProtocolMessage;
      try {
        message = parseProtocolMessage(JSON.parse(data.toString()));
      } catch {
        return;
      }
      for (const waiter of connection.waiters) {
        if (!waiter.filter(message)) {
          continue;
        }
        clearTimeout(waiter.timer);
        connection.waiters.delete(waiter);
        waiter.resolve(message);
      }
    });
    ws.on("close", () => {
      connection.closed = true;
      connection.rejectWaiters(new Error("WebSocket connection closed before protocol response"));
    });
    connection.send(makeProtocolMessage({
      type: "hello",
      room: options.room,
      from: options.agentId,
      payload: {
        token: options.token,
        kind: options.kind ?? "cli",
        capabilities: ["agent.message", "workspace.grants", "file.transfer"]
      }
    }));
    await connection.waitFor((message) => message.type === "hello.ack", 5000);
    return connection;
  }

  send(message: ProtocolMessage): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket connection is not open");
    }
    this.ws.send(JSON.stringify(message));
  }

  waitFor(filter: (message: ProtocolMessage) => boolean, timeoutMs: number): Promise<ProtocolMessage> {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      return Promise.reject(new Error("WebSocket connection closed before protocol response"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timed out waiting for protocol response"));
      }, timeoutMs);
      const waiter: ProtocolWaiter = { filter, resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

function requireRelayConfig(config: CodexComsConfig): ProtocolConnectionOptions {
  if (!config.relay || !config.room || !config.token) {
    throw new Error("relay, room, and token must be configured; run codex-coms connect or pass them to init/connect");
  }
  return {
    relay: config.relay,
    room: config.room,
    token: config.token,
    agentId: config.agentId
  };
}

export async function sendProtocolMessage(config: CodexComsConfig, message: ProtocolMessage, waitMs = 250): Promise<void> {
  const connection = await ProtocolConnection.open({ ...requireRelayConfig(config), kind: "cli" });
  try {
    connection.send(message);
    try {
      const response = await connection.waitFor((item) => {
        return item.type === "error" && (item.payload as Record<string, unknown>).requestId === message.id;
      }, waitMs);
      throw new Error(`${String((response.payload as Record<string, unknown>).message)}. Target peers must have codex-coms connect running; one-shot sends are not inbox-queued.`);
    } catch (error) {
      if ((error as Error).message !== "timed out waiting for protocol response") {
        throw error;
      }
    }
  } finally {
    connection.close();
  }
}

export async function requestProtocolResponse(config: CodexComsConfig, message: ProtocolMessage, responseTypes: ProtocolType[], timeoutMs = 5000): Promise<ProtocolMessage> {
  const connection = await ProtocolConnection.open({ ...requireRelayConfig(config), kind: "cli" });
  try {
    connection.send(message);
    const response = await connection.waitFor((item) => {
      if (item.type === "error" && (item.payload as Record<string, unknown>).requestId === message.id) {
        return true;
      }
      if (!responseTypes.includes(item.type)) {
        return false;
      }
      return (item.payload as Record<string, unknown>).requestId === message.id;
    }, timeoutMs);
    if (response.type === "error") {
      throw new Error(`${String((response.payload as Record<string, unknown>).message)}. Target peers must have codex-coms connect running; one-shot sends are not inbox-queued.`);
    }
    return response;
  } finally {
    connection.close();
  }
}

export async function sendAgentMessage(config: CodexComsConfig, to: string, text: string): Promise<ProtocolMessage> {
  const message = makeProtocolMessage({
    type: "agent.message",
    room: config.room ?? "default",
    from: config.agentId,
    to,
    payload: { text }
  });
  let connection: ProtocolConnection | undefined;
  try {
    connection = await ProtocolConnection.open({ ...requireRelayConfig(config), kind: "cli" });
    connection.send(message);
    const response = await connection.waitFor((item) => {
      if (item.type === "error" && (item.payload as Record<string, unknown>).requestId === message.id) {
        return true;
      }
      return item.type === "agent.message.ack" && (item.payload as Record<string, unknown>).messageId === message.id;
    }, 5000);
    if (response.type === "error") {
      throw new Error(`${String((response.payload as Record<string, unknown>).message)}. Target peers must have codex-coms connect running; one-shot sends are not inbox-queued.`);
    }
    await appendOutboxEntry(config.dataDir, {
      id: message.id,
      to,
      type: message.type,
      summary: text.slice(0, 200),
      delivered: true
    });
    await appendAudit(config.dataDir, {
      event: "message_sent",
      actor: config.agentId,
      peer: to,
      messageId: message.id,
      result: "ok"
    });
  } catch (error) {
    const reason = (error as Error).message;
    await appendOutboxEntry(config.dataDir, {
      id: message.id,
      to,
      type: message.type,
      summary: text.slice(0, 200),
      delivered: false,
      error: reason
    });
    await appendAudit(config.dataDir, {
      event: "send_failed",
      actor: config.agentId,
      peer: to,
      messageId: message.id,
      result: "error",
      details: { reason }
    });
    throw error;
  } finally {
    connection?.close();
  }
  return message;
}

export async function requestRoomPeers(config: CodexComsConfig): Promise<Array<{ agentId: string; sockets: number; kinds: string[] }>> {
  const message = makeProtocolMessage({
    type: "room.peers.request",
    room: config.room ?? "default",
    from: config.agentId,
    payload: {}
  });
  const response = await requestProtocolResponse(config, message, ["room.peers.response"]);
  return RoomPeersResponsePayloadSchema.parse(response.payload).peers;
}

export async function sendFileToPeer(config: CodexComsConfig, to: string, filePath: string): Promise<string> {
  const transfer = await prepareFileTransfer(filePath);
  const connection = await ProtocolConnection.open({ ...requireRelayConfig(config), kind: "cli" });
  try {
    const offer = makeProtocolMessage({
      type: "file.offer",
      room: config.room ?? "default",
      from: config.agentId,
      to,
      payload: {
        transferId: transfer.transferId,
        filename: transfer.filename,
        size: transfer.size,
        sha256: transfer.sha256,
        chunkSize: transfer.chunkSize,
        chunkCount: transfer.chunkCount
      }
    });
    connection.send(offer);
    const accept = await connection.waitFor((message) => {
      if (message.type === "error" && (message.payload as Record<string, unknown>).requestId === offer.id) {
        return true;
      }
      return message.type === "file.accept" && (message.payload as Record<string, unknown>).transferId === transfer.transferId;
    }, 5000);
    if (accept.type === "error") {
      throw new Error(`${String((accept.payload as Record<string, unknown>).message)}. Target peers must have codex-coms connect running; one-shot sends are not inbox-queued.`);
    }
    const accepted = FileAcceptPayloadSchema.parse(accept.payload);
    if (!accepted.accepted) {
      throw new Error(accepted.reason ?? "peer rejected file");
    }
    for (let index = 0; index < transfer.chunks.length; index += 1) {
      connection.send(makeProtocolMessage({
        type: "file.chunk",
        room: config.room ?? "default",
        from: config.agentId,
        to,
        payload: {
          transferId: transfer.transferId,
          index,
          dataBase64: transfer.chunks[index]
        }
      }));
    }
    connection.send(makeProtocolMessage({
      type: "file.complete",
      room: config.room ?? "default",
      from: config.agentId,
      to,
      payload: {
        transferId: transfer.transferId
      }
    }));
    await appendAudit(config.dataDir, {
      event: "file_offered",
      actor: config.agentId,
      peer: to,
      messageId: offer.id,
      result: "ok",
      details: { transferId: transfer.transferId, filename: transfer.filename, size: transfer.size }
    });
    return transfer.transferId;
  } finally {
    connection.close();
  }
}

export class PeerSidecar {
  private connection?: ProtocolConnection;
  private readonly receiver: FileTransferReceiver;
  private closedPromise?: Promise<void>;
  private closeResolve?: () => void;

  constructor(private readonly config: CodexComsConfig) {
    this.receiver = new FileTransferReceiver(config.dataDir, config.agentId);
  }

  async start(): Promise<void> {
    this.connection = await ProtocolConnection.open({ ...requireRelayConfig(this.config), kind: "sidecar" });
    await setRuntimeStatus(this.config.dataDir, {
      connected: true,
      agentId: this.config.agentId,
      pid: process.pid,
      relay: this.config.relay,
      room: this.config.room,
      connectedAt: new Date().toISOString()
    });
    this.closedPromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    const ws = (this.connection as unknown as { ws: WebSocket }).ws;
    ws.on("message", (data) => this.handleRawMessage(data.toString()).catch((error) => {
      appendAudit(this.config.dataDir, {
        event: "error",
        actor: this.config.agentId,
        result: "error",
        details: { message: (error as Error).message }
      }).catch(() => undefined);
    }));
    ws.on("close", () => {
      (async () => {
        const previous = await loadRuntimeStatus(this.config.dataDir);
        await setRuntimeStatus(this.config.dataDir, {
          connected: false,
          agentId: this.config.agentId,
          pid: process.pid,
          relay: this.config.relay,
          room: this.config.room,
          connectedAt: previous.connectedAt,
          disconnectedAt: new Date().toISOString()
        });
      })().finally(() => this.closeResolve?.());
    });
    await appendAudit(this.config.dataDir, {
      event: "sidecar_connected",
      actor: this.config.agentId,
      result: "ok",
      details: { relay: this.config.relay, room: this.config.room }
    });
  }

  async waitForClose(): Promise<void> {
    await this.closedPromise;
  }

  async stop(): Promise<void> {
    this.connection?.close();
    await this.waitForClose();
  }

  private async handleRawMessage(raw: string): Promise<void> {
    const message = parseProtocolMessage(JSON.parse(raw));
    if (message.to && message.to !== this.config.agentId) {
      return;
    }
    await this.handleMessage(message);
  }

  private async handleMessage(message: ProtocolMessage): Promise<void> {
    switch (message.type) {
      case "agent.message":
        await this.handleAgentMessage(message);
        break;
      case "workspace.grant.request":
        await this.handleGrantRequest(message);
        break;
      case "workspace.grant.created":
        await this.handleGrantCreated(message);
        break;
      case "workspace.grant.revoked":
        await this.handleGrantRevoked(message);
        break;
      case "workspace.list.request":
        await this.handleListRequest(message);
        break;
      case "workspace.read.request":
        await this.handleReadRequest(message);
        break;
      case "file.offer":
        await this.handleFileOffer(message);
        break;
      case "file.chunk":
        FileChunkPayloadSchema.parse(message.payload);
        this.receiver.receiveChunk(message);
        break;
      case "file.complete":
        await this.handleFileComplete(message);
        break;
      case "error":
        await this.handleError(message);
        break;
      default:
        break;
    }
  }

  private send(message: ProtocolMessage): void {
    this.connection?.send(message);
  }

  private async appendInboxAndWake(entry: InboxEntry): Promise<void> {
    await appendInboxEntry(this.config.dataDir, entry);
    try {
      await dispatchWakeEvent({
        dataDir: this.config.dataDir,
        workspace: this.config.workspace,
        localAgentId: this.config.agentId,
        entry,
        config: this.config.wake
      });
    } catch (error) {
      await appendAudit(this.config.dataDir, {
        event: "wake_failed",
        actor: this.config.agentId,
        peer: entry.from,
        messageId: entry.id,
        result: "error",
        details: { reason: (error as Error).message }
      });
    }
  }

  private async handleAgentMessage(message: ProtocolMessage): Promise<void> {
    const payload = validatePayload("agent.message", message.payload);
    await this.appendInboxAndWake({
      id: message.id,
      timestamp: message.timestamp,
      from: message.from,
      type: message.type,
      summary: String(payload.text).slice(0, 500),
      actionHint: "Read and reply with codex-coms send if needed.",
      read: false,
      payload: message.payload
    });
    await appendAudit(this.config.dataDir, {
      event: "message_received",
      actor: this.config.agentId,
      peer: message.from,
      messageId: message.id,
      result: "ok"
    });
    this.send(makeProtocolMessage({
      type: "agent.message.ack",
      room: this.config.room ?? "default",
      from: this.config.agentId,
      to: message.from,
      payload: {
        messageId: message.id
      }
    }));
  }

  private async handleGrantRequest(message: ProtocolMessage): Promise<void> {
    const payload = WorkspaceGrantRequestPayloadSchema.parse(message.payload);
    await this.appendInboxAndWake({
      id: message.id,
      timestamp: message.timestamp,
      from: message.from,
      type: message.type,
      summary: `${message.from} requested read access to ${payload.path}: ${payload.reason}`,
      actionHint: "Grant the narrowest file or directory with codex-coms grant, or ignore.",
      read: false,
      payload: message.payload
    });
    await appendAudit(this.config.dataDir, {
      event: "grant_requested",
      actor: this.config.agentId,
      peer: message.from,
      messageId: message.id,
      result: "ok",
      details: { path: payload.path }
    });
  }

  private async handleGrantCreated(message: ProtocolMessage): Promise<void> {
    const payload = WorkspaceGrantCreatedPayloadSchema.parse(message.payload);
    await this.appendInboxAndWake({
      id: message.id,
      timestamp: message.timestamp,
      from: message.from,
      type: message.type,
      summary: `${message.from} granted ${payload.name} (${payload.grantId}) until ${payload.expiresAt}`,
      actionHint: "List first with codex-coms list-remote, then read only needed files.",
      read: false,
      payload: message.payload
    });
  }

  private async handleGrantRevoked(message: ProtocolMessage): Promise<void> {
    const payload = WorkspaceGrantRevokedPayloadSchema.parse(message.payload);
    await this.appendInboxAndWake({
      id: message.id,
      timestamp: message.timestamp,
      from: message.from,
      type: message.type,
      summary: `${message.from} revoked grant ${payload.grantId}`,
      actionHint: "Stop using that grant ID.",
      read: false,
      payload: message.payload
    });
    await appendAudit(this.config.dataDir, {
      event: "grant_revoked_notice_received",
      actor: this.config.agentId,
      peer: message.from,
      messageId: message.id,
      result: "ok"
    });
  }

  private async handleListRequest(message: ProtocolMessage): Promise<void> {
    const payload = WorkspaceListRequestPayloadSchema.parse(message.payload);
    const grant = await findUsableGrant({
      dataDir: this.config.dataDir,
      ownerAgentId: this.config.agentId,
      requesterAgentId: message.from,
      grantId: payload.grantId
    });
    try {
      if (!grant) {
        throw new FsAccessError("grant is missing, revoked, expired, or scoped to another peer");
      }
      const entries = await listGrantedPath(grant, payload.path);
      await appendAudit(this.config.dataDir, {
        event: "remote_list_allowed",
        actor: this.config.agentId,
        peer: message.from,
        messageId: message.id,
        result: "allowed",
        details: { grantId: payload.grantId, path: payload.path }
      });
      this.send(makeProtocolMessage({
        type: "workspace.list.response",
        room: this.config.room ?? "default",
        from: this.config.agentId,
        to: message.from,
        payload: {
          ok: true,
          requestId: message.id,
          entries
        }
      }));
    } catch (error) {
      await appendAudit(this.config.dataDir, {
        event: "remote_list_denied",
        actor: this.config.agentId,
        peer: message.from,
        messageId: message.id,
        result: "denied",
        details: { grantId: payload.grantId, path: payload.path, reason: (error as Error).message }
      });
      this.send(makeProtocolMessage({
        type: "workspace.list.response",
        room: this.config.room ?? "default",
        from: this.config.agentId,
        to: message.from,
        payload: {
          ok: false,
          requestId: message.id,
          error: (error as Error).message
        }
      }));
    }
  }

  private async handleReadRequest(message: ProtocolMessage): Promise<void> {
    const payload = WorkspaceReadRequestPayloadSchema.parse(message.payload);
    const grant = await findUsableGrant({
      dataDir: this.config.dataDir,
      ownerAgentId: this.config.agentId,
      requesterAgentId: message.from,
      grantId: payload.grantId
    });
    try {
      if (!grant) {
        throw new FsAccessError("grant is missing, revoked, expired, or scoped to another peer");
      }
      const file = await readGrantedFile(grant, payload.path);
      await appendAudit(this.config.dataDir, {
        event: "remote_read_allowed",
        actor: this.config.agentId,
        peer: message.from,
        messageId: message.id,
        result: "allowed",
        details: { grantId: payload.grantId, path: payload.path, size: file.size }
      });
      this.send(makeProtocolMessage({
        type: "workspace.read.response",
        room: this.config.room ?? "default",
        from: this.config.agentId,
        to: message.from,
        payload: {
          ok: true,
          requestId: message.id,
          ...file
        }
      }));
    } catch (error) {
      await appendAudit(this.config.dataDir, {
        event: "remote_read_denied",
        actor: this.config.agentId,
        peer: message.from,
        messageId: message.id,
        result: "denied",
        details: { grantId: payload.grantId, path: payload.path, reason: (error as Error).message }
      });
      this.send(makeProtocolMessage({
        type: "workspace.read.response",
        room: this.config.room ?? "default",
        from: this.config.agentId,
        to: message.from,
        payload: {
          ok: false,
          requestId: message.id,
          error: (error as Error).message
        }
      }));
    }
  }

  private async handleFileOffer(message: ProtocolMessage): Promise<void> {
    FileOfferPayloadSchema.parse(message.payload);
    const accepted = await this.receiver.acceptOffer(message);
    this.send(makeProtocolMessage({
      type: "file.accept",
      room: this.config.room ?? "default",
      from: this.config.agentId,
      to: message.from,
      payload: {
        transferId: String((message.payload as Record<string, unknown>).transferId),
        ...accepted
      }
    }));
  }

  private async handleFileComplete(message: ProtocolMessage): Promise<void> {
    FileCompletePayloadSchema.parse(message.payload);
    const result = await this.receiver.complete(message);
    await this.appendInboxAndWake({
      id: message.id,
      timestamp: message.timestamp,
      from: message.from,
      type: "file.complete",
      summary: `${message.from} sent file ${result.path}`,
      actionHint: "Inspect transferred files before using them. Never execute received files blindly.",
      read: false,
      payload: {
        ...message.payload,
        localPath: result.path,
        size: result.size,
        sha256: result.sha256
      }
    });
  }

  private async handleError(message: ProtocolMessage): Promise<void> {
    await this.appendInboxAndWake({
      id: message.id,
      timestamp: message.timestamp,
      from: message.from,
      type: "error",
      summary: String((message.payload as Record<string, unknown>).message ?? "protocol error"),
      actionHint: "Check relay/sidecar status and retry if needed.",
      read: false,
      payload: message.payload
    });
  }
}

export function parseListResponse(message: ProtocolMessage) {
  return WorkspaceListResponsePayloadSchema.parse(message.payload);
}

export function parseReadResponse(message: ProtocolMessage) {
  return WorkspaceReadResponsePayloadSchema.parse(message.payload);
}
