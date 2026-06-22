import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/config.js";
import { listGrantedPath, readGrantedFile } from "../src/workspace/fsAccess.js";
import { createGrant, findUsableGrant, revokeGrant } from "../src/workspace/grants.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace grants", () => {
  it("allows granted reads and lists", async () => {
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "note.txt"), "hello\n", "utf8");
    const config = await initWorkspace({ agentId: "bob", workspace: root });
    const grant = await createGrant({
      dataDir: config.dataDir,
      workspace: root,
      ownerAgentId: "bob",
      targetAgentId: "alice",
      grantPath: "shared",
      name: "shared",
      ttl: "2h"
    });
    const entries = await listGrantedPath(grant, ".");
    const read = await readGrantedFile(grant, "note.txt");
    expect(entries.map((entry) => entry.name)).toContain("note.txt");
    expect(Buffer.from(read.contentBase64, "base64").toString("utf8")).toBe("hello\n");
  });

  it("denies traversal outside the grant", async () => {
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "note.txt"), "hello\n", "utf8");
    await writeFile(path.join(root, "secret.txt"), "secret\n", "utf8");
    const config = await initWorkspace({ agentId: "bob", workspace: root });
    const grant = await createGrant({
      dataDir: config.dataDir,
      workspace: root,
      ownerAgentId: "bob",
      targetAgentId: "alice",
      grantPath: "shared",
      name: "shared",
      ttl: "2h"
    });
    await expect(readGrantedFile(grant, "../secret.txt")).rejects.toThrow("path traversal");
  });

  it("denies secret files inside a grant", async () => {
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", ".env"), "TOKEN=value\n", "utf8");
    const config = await initWorkspace({ agentId: "bob", workspace: root });
    const grant = await createGrant({
      dataDir: config.dataDir,
      workspace: root,
      ownerAgentId: "bob",
      targetAgentId: "alice",
      grantPath: "shared",
      name: "shared",
      ttl: "2h"
    });
    await expect(readGrantedFile(grant, ".env")).rejects.toThrow("secret filter");
  });

  it("honors revocation and peer scoping", async () => {
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "shared", "note.txt"), "hello\n", "utf8");
    const config = await initWorkspace({ agentId: "bob", workspace: root });
    const grant = await createGrant({
      dataDir: config.dataDir,
      workspace: root,
      ownerAgentId: "bob",
      targetAgentId: "alice",
      grantPath: "shared",
      name: "shared",
      ttl: "2h"
    });
    expect(await findUsableGrant({
      dataDir: config.dataDir,
      ownerAgentId: "bob",
      requesterAgentId: "carol",
      grantId: grant.id
    })).toBeUndefined();
    await revokeGrant(config.dataDir, grant.id);
    expect(await findUsableGrant({
      dataDir: config.dataDir,
      ownerAgentId: "bob",
      requesterAgentId: "alice",
      grantId: grant.id
    })).toBeUndefined();
  });
});
