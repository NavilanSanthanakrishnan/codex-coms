import { describe, expect, it } from "vitest";
import { ProtocolConnection } from "../src/peer/client.js";
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
});
