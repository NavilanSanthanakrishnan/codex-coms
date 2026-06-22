import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../src/config.js";

describe("config JSON persistence", () => {
  it("uses unique temp files for concurrent writes to the same target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-config-"));
    try {
      const file = path.join(root, "status.json");
      const writes = Array.from({ length: 200 }, (_, index) => writeJson(file, { index }));

      await expect(Promise.all(writes)).resolves.toHaveLength(200);

      const value = await readJson<{ index: number }>(file, { index: -1 });
      expect(value.index).toBeGreaterThanOrEqual(0);
      expect(value.index).toBeLessThan(200);

      const files = await readdir(root);
      expect(files.filter((item) => item.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
