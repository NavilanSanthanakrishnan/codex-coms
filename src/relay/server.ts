import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { makeProtocolMessage, parseProtocolMessage } from "../protocol/schema.js";
import type { ProtocolMessage, RoomPeer } from "../protocol/types.js";

export interface RelayServerOptions {
  host: string;
  port: number;
  token: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

interface RelayConnection {
  ws: WebSocket;
  agentId: string;
  room: string;
  kind: string;
  connectedAt: string;
  lastSeenAt: string;
}

function formatCloseReason(reason: Buffer<ArrayBufferLike>): string {
  const value = reason.toString("utf8").replace(/[\r\n\t]+/g, " ").trim();
  if (!value) {
    return "(none)";
  }
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

export class RelayServer {
  private httpServer?: http.Server;
  private wsServer?: WebSocketServer;
  private readonly rooms = new Map<string, Map<string, Set<RelayConnection>>>();
  private readonly connections = new Map<WebSocket, RelayConnection>();
  private actualPort?: number;

  constructor(private readonly options: RelayServerOptions) {}

  async start(): Promise<{ host: string; port: number; url: string }> {
    this.httpServer = http.createServer();
    this.wsServer = new WebSocketServer({ server: this.httpServer, maxPayload: 2 * 1024 * 1024 });
    this.wsServer.on("connection", (ws) => this.handleConnection(ws));
    await new Promise<void>((resolve) => {
      this.httpServer?.listen(this.options.port, this.options.host, resolve);
    });
    const address = this.httpServer.address();
    this.actualPort = typeof address === "object" && address ? address.port : this.options.port;
    this.options.logger?.log(`codex-coms relay listening on ws://${this.options.host}:${this.actualPort}`);
    return {
      host: this.options.host,
      port: this.actualPort,
      url: `ws://${this.options.host}:${this.actualPort}`
    };
  }

  async stop(): Promise<void> {
    for (const connection of this.connections.values()) {
      connection.ws.close();
    }
    await new Promise<void>((resolve) => this.wsServer?.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
  }

  get url(): string {
    if (!this.actualPort) {
      throw new Error("relay is not started");
    }
    return `ws://${this.options.host}:${this.actualPort}`;
  }

  private handleConnection(ws: WebSocket): void {
    ws.once("message", (data) => {
      try {
        const message = parseProtocolMessage(JSON.parse(data.toString()));
        if (message.type !== "hello") {
          this.sendError(ws, "auth_required", "first message must be hello", message.id, message.room, message.from);
          ws.close();
          return;
        }
        const token = String(message.payload.token);
        if (token !== this.options.token) {
          this.sendError(ws, "auth_failed", "invalid room token", message.id, message.room, message.from);
          ws.close();
          return;
        }
        this.register(ws, message);
        ws.on("message", (next) => this.handleMessage(ws, next.toString()));
      } catch (error) {
        this.options.logger?.warn(`relay rejected connection: ${(error as Error).message}`);
        ws.close();
      }
    });
    ws.on("close", (code, reason) => this.unregister(ws, code, reason));
  }

  private register(ws: WebSocket, hello: ProtocolMessage): void {
    const connectedAt = new Date().toISOString();
    const connection: RelayConnection = {
      ws,
      agentId: hello.from,
      room: hello.room,
      kind: String(hello.payload.kind ?? "unknown"),
      connectedAt,
      lastSeenAt: connectedAt
    };
    let room = this.rooms.get(connection.room);
    if (!room) {
      room = new Map();
      this.rooms.set(connection.room, room);
    }
    let sockets = room.get(connection.agentId);
    if (!sockets) {
      sockets = new Set();
      room.set(connection.agentId, sockets);
    }
    sockets.add(connection);
    this.connections.set(ws, connection);
    this.send(ws, makeProtocolMessage({
      type: "hello.ack",
      room: connection.room,
      from: "relay",
      to: connection.agentId,
      payload: {
        accepted: true,
        agentCount: room.size
      }
    }));
    this.options.logger?.log(`relay connected agent=${connection.agentId} room=${connection.room} kind=${connection.kind}`);
  }

  private unregister(ws: WebSocket, code = 1005, reason: Buffer<ArrayBufferLike> = Buffer.alloc(0)): void {
    const connection = this.connections.get(ws);
    if (!connection) {
      return;
    }
    this.connections.delete(ws);
    const room = this.rooms.get(connection.room);
    const sockets = room?.get(connection.agentId);
    sockets?.delete(connection);
    if (sockets && sockets.size === 0) {
      room?.delete(connection.agentId);
    }
    if (room && room.size === 0) {
      this.rooms.delete(connection.room);
    }
    this.options.logger?.log(`relay disconnected agent=${connection.agentId} room=${connection.room} kind=${connection.kind} code=${code} reason=${formatCloseReason(reason)}`);
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    const connection = this.connections.get(ws);
    if (!connection) {
      ws.close();
      return;
    }
    let message: ProtocolMessage;
    try {
      message = parseProtocolMessage(JSON.parse(raw));
    } catch (error) {
      this.sendError(ws, "invalid_message", (error as Error).message, undefined, connection.room, connection.agentId);
      return;
    }
    if (message.type === "hello") {
      this.sendError(ws, "invalid_message", "hello is only allowed as the first frame", message.id, connection.room, connection.agentId);
      return;
    }
    if (message.room !== connection.room || message.from !== connection.agentId) {
      this.sendError(ws, "forbidden", "message room/from does not match connection", message.id, connection.room, connection.agentId);
      return;
    }
    connection.lastSeenAt = new Date().toISOString();
    if (message.type === "room.peers.request") {
      this.send(ws, makeProtocolMessage({
        type: "room.peers.response",
        room: connection.room,
        from: "relay",
        to: connection.agentId,
        payload: {
          requestId: message.id,
          peers: this.listRoomPeers(connection.room)
        }
      }));
      return;
    }
    if (!message.to) {
      this.sendError(ws, "missing_target", "message must include a target", message.id, connection.room, connection.agentId);
      return;
    }
    const targetSockets = this.rooms.get(connection.room)?.get(message.to);
    if (!targetSockets || targetSockets.size === 0) {
      this.sendError(ws, "target_offline", `target ${message.to} is not connected`, message.id, connection.room, connection.agentId);
      return;
    }
    for (const target of targetSockets) {
      this.send(target.ws, message);
    }
  }

  private send(ws: WebSocket, message: ProtocolMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private listRoomPeers(roomName: string): RoomPeer[] {
    const room = this.rooms.get(roomName);
    if (!room) {
      return [];
    }
    return [...room.entries()].map(([agentId, sockets]) => {
      const socketList = [...sockets];
      const connectedAt = socketList.map((connection) => connection.connectedAt).sort()[0] ?? new Date(0).toISOString();
      const lastSeenAt = socketList.map((connection) => connection.lastSeenAt).sort().at(-1) ?? connectedAt;
      return {
        agentId,
        sockets: sockets.size,
        kinds: [...new Set(socketList.map((connection) => connection.kind))].sort(),
        connectedAt,
        lastSeenAt
      };
    }).sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private sendError(ws: WebSocket, code: string, message: string, requestId: string | undefined, room: string, to: string): void {
    this.send(ws, makeProtocolMessage({
      type: "error",
      room,
      from: "relay",
      to,
      payload: {
        code,
        message,
        requestId
      }
    }));
  }
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const server = new RelayServer(options);
  await server.start();
  return server;
}
