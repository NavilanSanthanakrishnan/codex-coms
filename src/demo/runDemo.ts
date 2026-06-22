import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendAudit } from "../audit/auditLog.js";
import { initWorkspace, saveConfig, type CodexComsConfig } from "../config.js";
import { PeerSidecar, parseListResponse, parseReadResponse, requestProtocolResponse, sendAgentMessage, sendFileToPeer } from "../peer/client.js";
import { readInboxEntries } from "../peer/inbox.js";
import { makeProtocolMessage } from "../protocol/schema.js";
import { RelayServer } from "../relay/server.js";
import { createGrant } from "../workspace/grants.js";

export interface DemoResult {
  root: string;
  relayUrl: string;
  alice: CodexComsConfig;
  bob: CodexComsConfig;
  bobInboxCount: number;
  grantId: string;
  remoteReadText: string;
  outsideReadDenied: boolean;
  transferId: string;
  transferredFile: string;
  auditLogsWritten: boolean;
}

async function waitFor<T>(producer: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await producer();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for demo condition");
}

export async function runDemo(options: { quiet?: boolean } = {}): Promise<DemoResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-demo-"));
  const token = randomUUID().replace(/-/g, "");
  const room = "demo";
  const relay = new RelayServer({
    host: "127.0.0.1",
    port: 0,
    token,
    logger: options.quiet ? undefined : console
  });
  const started = await relay.start();
  const aliceWorkspace = path.join(root, "alice-workspace");
  const bobWorkspace = path.join(root, "bob-workspace");
  await mkdir(aliceWorkspace, { recursive: true });
  await mkdir(path.join(bobWorkspace, "notes"), { recursive: true });
  await writeFile(path.join(bobWorkspace, "notes", "context.md"), "# Bob Context\n\nThe answer is in this granted file.\n", "utf8");
  await writeFile(path.join(bobWorkspace, "secret.txt"), "do not expose\n", "utf8");
  const aliceFile = path.join(aliceWorkspace, "handoff.txt");
  await writeFile(aliceFile, "artifact from alice\n", "utf8");
  const alice = await initWorkspace({
    agentId: "alice",
    workspace: aliceWorkspace,
    relay: started.url,
    room,
    token
  });
  const bob = await initWorkspace({
    agentId: "bob",
    workspace: bobWorkspace,
    relay: started.url,
    room,
    token
  });
  await saveConfig(alice);
  await saveConfig(bob);
  const aliceSidecar = new PeerSidecar(alice);
  const bobSidecar = new PeerSidecar(bob);
  await aliceSidecar.start();
  await bobSidecar.start();
  try {
    await sendAgentMessage(alice, "bob", "hello from alice");
    await waitFor(async () => {
      const entries = await readInboxEntries(bob.dataDir);
      return entries.find((entry) => entry.type === "agent.message") ? entries : undefined;
    });
    const grant = await createGrant({
      dataDir: bob.dataDir,
      workspace: bob.workspace,
      ownerAgentId: "bob",
      targetAgentId: "alice",
      grantPath: "notes",
      name: "demo-notes",
      ttl: "2h"
    });
    await appendAudit(bob.dataDir, {
      event: "grant_created",
      actor: "bob",
      peer: "alice",
      result: "ok",
      details: { grantId: grant.id, path: grant.path }
    });
    const listMessage = makeProtocolMessage({
      type: "workspace.list.request",
      room,
      from: "alice",
      to: "bob",
      payload: {
        grantId: grant.id,
        path: "."
      }
    });
    const listResponse = parseListResponse(await requestProtocolResponse(alice, listMessage, ["workspace.list.response"]));
    if (!listResponse.ok || !listResponse.entries.find((entry) => entry.name === "context.md")) {
      throw new Error("demo list did not return context.md");
    }
    const readMessage = makeProtocolMessage({
      type: "workspace.read.request",
      room,
      from: "alice",
      to: "bob",
      payload: {
        grantId: grant.id,
        path: "context.md"
      }
    });
    const readResponse = parseReadResponse(await requestProtocolResponse(alice, readMessage, ["workspace.read.response"]));
    if (!readResponse.ok) {
      throw new Error(readResponse.error);
    }
    const outsideMessage = makeProtocolMessage({
      type: "workspace.read.request",
      room,
      from: "alice",
      to: "bob",
      payload: {
        grantId: grant.id,
        path: "../secret.txt"
      }
    });
    const outsideResponse = parseReadResponse(await requestProtocolResponse(alice, outsideMessage, ["workspace.read.response"]));
    const transferId = await sendFileToPeer(alice, "bob", aliceFile);
    const transferredFile = await waitFor(async () => {
      const entries = await readInboxEntries(bob.dataDir);
      const transfer = entries.find((entry) => entry.type === "file.complete");
      return transfer?.payload.localPath as string | undefined;
    });
    const auditLogsWritten = (await readFile(path.join(alice.dataDir, "audit.jsonl"), "utf8")).length > 0 && (await readFile(path.join(bob.dataDir, "audit.jsonl"), "utf8")).length > 0;
    return {
      root,
      relayUrl: started.url,
      alice,
      bob,
      bobInboxCount: (await readInboxEntries(bob.dataDir)).length,
      grantId: grant.id,
      remoteReadText: Buffer.from(readResponse.contentBase64, "base64").toString("utf8"),
      outsideReadDenied: !outsideResponse.ok,
      transferId,
      transferredFile,
      auditLogsWritten
    };
  } finally {
    await aliceSidecar.stop();
    await bobSidecar.stop();
    await relay.stop();
  }
}
