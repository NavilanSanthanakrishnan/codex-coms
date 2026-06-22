import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProtocolMessage } from "../protocol/types.js";
import { appendAudit } from "../audit/auditLog.js";

export const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

interface IncomingTransfer {
  from: string;
  filename: string;
  size: number;
  sha256: string;
  chunkCount: number;
  chunks: Buffer[];
  received: Set<number>;
}

export interface PreparedFileTransfer {
  transferId: string;
  filename: string;
  size: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  chunks: string[];
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || base === "." || base === "..") {
    return "file";
  }
  return base.slice(0, 255);
}

export function sanitizeTransferId(transferId: string): string {
  const safe = transferId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  if (!safe || safe === "." || safe === "..") {
    return "transfer";
  }
  return safe;
}

export async function prepareFileTransfer(filePath: string, chunkSize = DEFAULT_CHUNK_SIZE): Promise<PreparedFileTransfer> {
  const content = await readFile(filePath);
  if (content.byteLength > MAX_TRANSFER_BYTES) {
    throw new Error(`file exceeds max transfer size of ${MAX_TRANSFER_BYTES} bytes`);
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < content.byteLength; offset += chunkSize) {
    chunks.push(content.subarray(offset, offset + chunkSize).toString("base64"));
  }
  return {
    transferId: `transfer_${randomUUID()}`,
    filename: sanitizeFilename(filePath),
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    chunkSize,
    chunkCount: chunks.length,
    chunks
  };
}

export class FileTransferReceiver {
  private readonly transfers = new Map<string, IncomingTransfer>();

  constructor(private readonly dataDir: string, private readonly localAgentId: string) {}

  async acceptOffer(message: ProtocolMessage): Promise<{ accepted: boolean; reason?: string }> {
    const payload = message.payload as Record<string, unknown>;
    const transferId = String(payload.transferId);
    const filename = sanitizeFilename(String(payload.filename));
    const size = Number(payload.size);
    const sha256 = String(payload.sha256);
    const chunkCount = Number(payload.chunkCount);
    if (size > MAX_TRANSFER_BYTES) {
      await appendAudit(this.dataDir, {
        event: "file_rejected",
        actor: this.localAgentId,
        peer: message.from,
        messageId: message.id,
        result: "denied",
        details: { transferId, reason: "size limit" }
      });
      return { accepted: false, reason: "file exceeds max transfer size" };
    }
    this.transfers.set(transferId, {
      from: message.from,
      filename,
      size,
      sha256,
      chunkCount,
      chunks: [],
      received: new Set()
    });
    await appendAudit(this.dataDir, {
      event: "file_accepted",
      actor: this.localAgentId,
      peer: message.from,
      messageId: message.id,
      result: "ok",
      details: { transferId, filename, size }
    });
    return { accepted: true };
  }

  receiveChunk(message: ProtocolMessage): void {
    const payload = message.payload as Record<string, unknown>;
    const transferId = String(payload.transferId);
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }
    const index = Number(payload.index);
    if (!Number.isInteger(index) || index < 0 || index >= transfer.chunkCount || transfer.received.has(index)) {
      return;
    }
    transfer.chunks[index] = Buffer.from(String(payload.dataBase64), "base64");
    transfer.received.add(index);
  }

  async complete(message: ProtocolMessage): Promise<{ path: string; size: number; sha256: string }> {
    const payload = message.payload as Record<string, unknown>;
    const transferId = String(payload.transferId);
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error("unknown transfer");
    }
    if (transfer.received.size !== transfer.chunkCount) {
      throw new Error("missing file chunks");
    }
    const content = Buffer.concat(transfer.chunks);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== transfer.size || sha256 !== transfer.sha256) {
      throw new Error("file hash or size does not match offer");
    }
    const targetDir = path.join(this.dataDir, "transfers", sanitizeFilename(transfer.from), sanitizeTransferId(transferId));
    await mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, transfer.filename);
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
    this.transfers.delete(transferId);
    await appendAudit(this.dataDir, {
      event: "file_completed",
      actor: this.localAgentId,
      peer: transfer.from,
      messageId: message.id,
      result: "ok",
      details: { transferId, path: target, sha256 }
    });
    return {
      path: target,
      size: content.byteLength,
      sha256
    };
  }
}
