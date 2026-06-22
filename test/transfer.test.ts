import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeProtocolMessage } from "../src/protocol/schema.js";
import { FileTransferReceiver, prepareFileTransfer, sanitizeTransferId } from "../src/transfer/fileTransfer.js";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("file transfer", () => {
  it("rejects invalid outgoing chunk sizes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-transfer-chunk-size-"));
    try {
      const file = path.join(root, "note.txt");
      await writeFile(file, "hello\n", "utf8");

      await expect(prepareFileTransfer(file, 0)).rejects.toThrow("chunkSize must be a positive safe integer");
      await expect(prepareFileTransfer(file, Number.NaN)).rejects.toThrow("chunkSize must be a positive safe integer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "negative size",
      payload: {
        size: -1,
        sha256: "0".repeat(64),
        chunkSize: 1,
        chunkCount: 1
      },
      reason: "invalid transfer size"
    },
    {
      name: "invalid sha256",
      payload: {
        size: 1,
        sha256: "not-a-sha",
        chunkSize: 1,
        chunkCount: 1
      },
      reason: "invalid transfer hash"
    },
    {
      name: "zero chunk size",
      payload: {
        size: 1,
        sha256: "0".repeat(64),
        chunkSize: 0,
        chunkCount: 1
      },
      reason: "invalid chunk size"
    },
    {
      name: "NaN chunk count",
      payload: {
        size: 1,
        sha256: "0".repeat(64),
        chunkSize: 1,
        chunkCount: Number.NaN
      },
      reason: "invalid chunk count"
    },
    {
      name: "mismatched chunk count",
      payload: {
        size: 3,
        sha256: "0".repeat(64),
        chunkSize: 2,
        chunkCount: 1
      },
      reason: "chunk count does not match size"
    }
  ])("rejects malformed incoming offer values for $name", async ({ payload, reason }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-transfer-offer-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      await mkdir(dataDir, { recursive: true });
      const receiver = new FileTransferReceiver(dataDir, "bob");
      const offer = makeProtocolMessage({
        type: "file.offer",
        room: "pair",
        from: "alice",
        to: "bob",
        payload: {
          transferId: "transfer_bad",
          filename: "note.txt",
          ...payload
        }
      });

      await expect(receiver.acceptOffer(offer)).resolves.toEqual({ accepted: false, reason });
      await expect(receiver.complete(makeProtocolMessage({
        type: "file.complete",
        room: "pair",
        from: "alice",
        to: "bob",
        payload: {
          transferId: "transfer_bad"
        }
      }))).rejects.toThrow("unknown transfer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "../../../outside",
    "/tmp/outside",
    "..\\..\\outside",
    "C:\\tmp\\outside"
  ])("stores received files under transfers for unsafe transfer ID %s", async (unsafeTransferId) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-transfer-path-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      await mkdir(dataDir, { recursive: true });
      const receiver = new FileTransferReceiver(dataDir, "bob");
      const content = Buffer.from("hello from alice\n");
      const sha256 = createHash("sha256").update(content).digest("hex");

      const offer = makeProtocolMessage({
        type: "file.offer",
        room: "pair",
        from: "alice",
        to: "bob",
        payload: {
          transferId: unsafeTransferId,
          filename: "../note.txt",
          size: content.byteLength,
          sha256,
          chunkSize: content.byteLength,
          chunkCount: 1
        }
      });
      expect(await receiver.acceptOffer(offer)).toEqual({ accepted: true });

      receiver.receiveChunk(makeProtocolMessage({
        type: "file.chunk",
        room: "pair",
        from: "alice",
        to: "bob",
        payload: {
          transferId: unsafeTransferId,
          index: 0,
          dataBase64: content.toString("base64")
        }
      }));

      const complete = makeProtocolMessage({
        type: "file.complete",
        room: "pair",
        from: "alice",
        to: "bob",
        payload: {
          transferId: unsafeTransferId
        }
      });
      const result = await receiver.complete(complete);

      const senderDir = path.join(dataDir, "transfers", "alice");
      const relative = path.relative(senderDir, result.path);
      expect(relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(result.path).toContain(sanitizeTransferId(unsafeTransferId));
      expect(await readFile(result.path, "utf8")).toBe(content.toString("utf8"));
      expect(await exists(path.join(root, "outside", "note.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
