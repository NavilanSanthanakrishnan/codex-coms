import { describe, expect, it } from "vitest";
import { makeProtocolMessage, parseProtocolMessage, safeParseProtocolMessage } from "../src/protocol/schema.js";

describe("protocol schema", () => {
  it("accepts a valid agent message", () => {
    const message = makeProtocolMessage({
      type: "agent.message",
      room: "pair",
      from: "alice",
      to: "bob",
      payload: {
        text: "hello"
      }
    });
    expect(parseProtocolMessage(message).type).toBe("agent.message");
  });

  it("rejects missing required envelope fields", () => {
    const result = safeParseProtocolMessage({
      version: 1,
      type: "agent.message",
      id: "missing-room",
      from: "alice",
      timestamp: new Date().toISOString(),
      payload: {
        text: "hello"
      }
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid payloads", () => {
    const message = makeProtocolMessage({
      type: "workspace.read.request",
      room: "pair",
      from: "alice",
      to: "bob",
      payload: {
        grantId: "grant_1"
      } as Record<string, unknown>
    });
    expect(safeParseProtocolMessage(message).success).toBe(false);
  });
});
