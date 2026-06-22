import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAuditLog } from "../src/audit/auditLog.js";
import { initWorkspace } from "../src/config.js";
import { ProtocolConnection, sendAgentMessage } from "../src/peer/client.js";
import { makeProtocolMessage } from "../src/protocol/schema.js";
import { RelayServer } from "../src/relay/server.js";

describe("relay server", () => {
  it("routes messages between agents in the same room", async () => {
    const relay = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const started = await relay.start();
    const alice = await ProtocolConnection.open({
      relay: started.url,
      room: "pair",
      agentId: "alice",
      token: "test-token",
      kind: "relay-test"
    });
    const bob = await ProtocolConnection.open({
      relay: started.url,
      room: "pair",
      agentId: "bob",
      token: "test-token",
      kind: "relay-test"
    });
    try {
      const message = makeProtocolMessage({
        type: "agent.message",
        room: "pair",
        from: "alice",
        to: "bob",
        payload: {
          text: "hello"
        }
      });
      const received = bob.waitFor((item) => item.type === "agent.message" && item.id === message.id, 2000);
      alice.send(message);
      expect((await received).payload.text).toBe("hello");
    } finally {
      alice.close();
      bob.close();
      await relay.stop();
    }
  });

  it("rejects a bad token", async () => {
    const relay = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const started = await relay.start();
    try {
      await expect(ProtocolConnection.open({
        relay: started.url,
        room: "pair",
        agentId: "alice",
        token: "bad-token",
        kind: "relay-test"
      })).rejects.toThrow();
    } finally {
      await relay.stop();
    }
  });

  it("reports connected room peers", async () => {
    const relay = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const started = await relay.start();
    const alice = await ProtocolConnection.open({
      relay: started.url,
      room: "pair",
      agentId: "alice",
      token: "test-token",
      kind: "relay-test"
    });
    const bob = await ProtocolConnection.open({
      relay: started.url,
      room: "pair",
      agentId: "bob",
      token: "test-token",
      kind: "relay-test"
    });
    try {
      const request = makeProtocolMessage({
        type: "room.peers.request",
        room: "pair",
        from: "alice",
        payload: {}
      });
      const response = alice.waitFor((item) => item.type === "room.peers.response" && item.payload.requestId === request.id, 2000);
      alice.send(request);
      expect((await response).payload.peers).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: "alice" }),
        expect.objectContaining({ agentId: "bob" })
      ]));
    } finally {
      alice.close();
      bob.close();
      await relay.stop();
    }
  });

  it("audits failed sends without recording message_sent ok", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-coms-send-fail-"));
    const relay = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const started = await relay.start();
    try {
      const config = await initWorkspace({
        agentId: "alice",
        workspace: root,
        relay: started.url,
        room: "pair",
        token: "test-token"
      });
      await expect(sendAgentMessage(config, "bob", "hello")).rejects.toThrow("Target peers must have codex-coms connect running");
      const audit = await readAuditLog(config.dataDir);
      expect(audit.some((entry) => entry.event === "send_failed")).toBe(true);
      expect(audit.some((entry) => entry.event === "message_sent" && entry.result === "ok")).toBe(false);
    } finally {
      await relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
