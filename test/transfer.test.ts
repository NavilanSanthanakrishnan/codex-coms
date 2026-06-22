import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeProtocolMessage } from "../src/protocol/schema.js";
import { FileTransferReceiver, sanitizeTransferId } from "../src/transfer/fileTransfer.js";

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
