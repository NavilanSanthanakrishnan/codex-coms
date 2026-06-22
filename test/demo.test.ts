import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo/runDemo.js";

describe("demo", () => {
  it("runs the two-agent happy path and denial check", async () => {
    const result = await runDemo({ quiet: true });
    try {
      expect(result.bobInboxCount).toBeGreaterThanOrEqual(2);
      expect(result.remoteReadText).toContain("Bob Context");
      expect(result.outsideReadDenied).toBe(true);
      expect(result.transferId).toMatch(/^transfer_/);
      expect(result.transferredFile).toContain(result.transferId);
      expect(result.auditLogsWritten).toBe(true);
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });
});
