import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, readAuditLog, redactSensitive } from "../src/audit/auditLog.js";

describe("audit log", () => {
  it("redacts sensitive and content-bearing fields recursively", () => {
    expect(redactSensitive({
      token: "room-token",
      path: "notes/context.md",
      contentBase64: "aGVsbG8=",
      nested: {
        dataBase64: "YmFzZTY0",
        body: "raw message body",
        text: "peer text"
      },
      list: [
        { payload: { text: "full payload text" } },
        { size: 12 }
      ]
    })).toEqual({
      token: "[redacted]",
      path: "notes/context.md",
      contentBase64: "[redacted]",
      nested: {
        dataBase64: "[redacted]",
        body: "[redacted]",
        text: "[redacted]"
      },
      list: [
        { payload: "[redacted]" },
        { size: 12 }
      ]
    });
  });

  it("persists redacted audit details", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-audit-"));
    try {
      const dataDir = path.join(root, ".codex-coms");
      await appendAudit(dataDir, {
        event: "workspace_read",
        actor: "bob",
        peer: "alice",
        result: "allowed",
        details: {
          path: "notes/context.md",
          contentBase64: "aGVsbG8=",
          authorization: "Bearer secret"
        }
      });

      await expect(readAuditLog(dataDir)).resolves.toEqual([
        expect.objectContaining({
          event: "workspace_read",
          details: {
            path: "notes/context.md",
            contentBase64: "[redacted]",
            authorization: "[redacted]"
          }
        })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
