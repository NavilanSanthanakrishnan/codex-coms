export const protocolTypes = [
  "hello",
  "hello.ack",
  "agent.message",
  "agent.message.ack",
  "room.peers.request",
  "room.peers.response",
  "workspace.grant.request",
  "workspace.grant.created",
  "workspace.grant.revoked",
  "workspace.list.request",
  "workspace.list.response",
  "workspace.read.request",
  "workspace.read.response",
  "file.offer",
  "file.accept",
  "file.chunk",
  "file.complete",
  "error"
] as const;

export type ProtocolType = (typeof protocolTypes)[number];

export type ProtocolVersion = 1;

export interface ProtocolMessage<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  version: ProtocolVersion;
  type: ProtocolType;
  id: string;
  room: string;
  from: string;
  to?: string;
  timestamp: string;
  payload: TPayload;
}

export interface FileTransferChunk {
  transferId: string;
  index: number;
  dataBase64: string;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface WorkspaceReadPayload {
  grantId: string;
  path: string;
}

export interface RoomPeer {
  agentId: string;
  sockets: number;
  kinds: string[];
  connectedAt?: string;
  lastSeenAt?: string;
}
