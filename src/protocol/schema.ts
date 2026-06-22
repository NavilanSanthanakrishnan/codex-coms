import { z } from "zod";
import { protocolTypes, type ProtocolMessage, type ProtocolType } from "./types.js";

export const PROTOCOL_VERSION = 1;

const idSchema = z.string().min(1).max(160);
const agentIdSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const roomSchema = z.string().min(1).max(160);
const isoTimestampSchema = z.string().datetime();
const textSchema = z.string().max(128 * 1024);
const pathSchema = z.string().min(0).max(4096);

export const HelloPayloadSchema = z.object({
  token: z.string().min(1).max(4096),
  kind: z.enum(["sidecar", "cli", "relay-test"]).default("cli"),
  capabilities: z.array(z.string().max(80)).default([])
});

export const HelloAckPayloadSchema = z.object({
  accepted: z.literal(true),
  agentCount: z.number().int().nonnegative()
});

export const AgentMessagePayloadSchema = z.object({
  text: textSchema
});

export const AgentMessageAckPayloadSchema = z.object({
  messageId: idSchema
});

export const WorkspaceGrantRequestPayloadSchema = z.object({
  path: pathSchema,
  reason: textSchema
});

export const WorkspaceGrantCreatedPayloadSchema = z.object({
  grantId: idSchema,
  name: z.string().min(1).max(160),
  path: pathSchema,
  expiresAt: isoTimestampSchema,
  maxReadBytes: z.number().int().positive(),
  maxListEntries: z.number().int().positive()
});

export const WorkspaceGrantRevokedPayloadSchema = z.object({
  grantId: idSchema
});

export const WorkspaceListRequestPayloadSchema = z.object({
  grantId: idSchema,
  path: pathSchema.default(".")
});

export const WorkspaceListResponsePayloadSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    requestId: idSchema,
    entries: z.array(z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(["file", "directory"]),
      size: z.number().int().nonnegative().optional()
    }))
  }),
  z.object({
    ok: z.literal(false),
    requestId: idSchema,
    error: textSchema
  })
]);

export const WorkspaceReadRequestPayloadSchema = z.object({
  grantId: idSchema,
  path: pathSchema
});

export const WorkspaceReadResponsePayloadSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    requestId: idSchema,
    path: pathSchema,
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentBase64: z.string()
  }),
  z.object({
    ok: z.literal(false),
    requestId: idSchema,
    error: textSchema
  })
]);

export const FileOfferPayloadSchema = z.object({
  transferId: idSchema,
  filename: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative()
});

export const FileAcceptPayloadSchema = z.object({
  transferId: idSchema,
  accepted: z.boolean(),
  reason: z.string().max(1024).optional()
});

export const FileChunkPayloadSchema = z.object({
  transferId: idSchema,
  index: z.number().int().nonnegative(),
  dataBase64: z.string()
});

export const FileCompletePayloadSchema = z.object({
  transferId: idSchema
});

export const ErrorPayloadSchema = z.object({
  code: z.string().min(1).max(120),
  message: textSchema,
  requestId: idSchema.optional()
});

const payloadSchemas = {
  "hello": HelloPayloadSchema,
  "hello.ack": HelloAckPayloadSchema,
  "agent.message": AgentMessagePayloadSchema,
  "agent.message.ack": AgentMessageAckPayloadSchema,
  "workspace.grant.request": WorkspaceGrantRequestPayloadSchema,
  "workspace.grant.created": WorkspaceGrantCreatedPayloadSchema,
  "workspace.grant.revoked": WorkspaceGrantRevokedPayloadSchema,
  "workspace.list.request": WorkspaceListRequestPayloadSchema,
  "workspace.list.response": WorkspaceListResponsePayloadSchema,
  "workspace.read.request": WorkspaceReadRequestPayloadSchema,
  "workspace.read.response": WorkspaceReadResponsePayloadSchema,
  "file.offer": FileOfferPayloadSchema,
  "file.accept": FileAcceptPayloadSchema,
  "file.chunk": FileChunkPayloadSchema,
  "file.complete": FileCompletePayloadSchema,
  "error": ErrorPayloadSchema
} satisfies Record<ProtocolType, z.ZodTypeAny>;

export const ProtocolBaseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.enum(protocolTypes),
  id: idSchema,
  room: roomSchema,
  from: agentIdSchema,
  to: agentIdSchema.optional(),
  timestamp: isoTimestampSchema,
  payload: z.record(z.string(), z.unknown())
});

export const ProtocolMessageSchema = ProtocolBaseSchema.superRefine((message, context) => {
  const schema = payloadSchemas[message.type];
  const parsed = schema.safeParse(message.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["payload", ...issue.path],
        message: issue.message
      });
    }
  }
});

export function parseProtocolMessage(input: unknown): ProtocolMessage {
  return ProtocolMessageSchema.parse(input) as ProtocolMessage;
}

export function safeParseProtocolMessage(input: unknown) {
  return ProtocolMessageSchema.safeParse(input);
}

export function makeProtocolMessage<TPayload extends Record<string, unknown>>(input: Omit<ProtocolMessage<TPayload>, "version" | "id" | "timestamp"> & Partial<Pick<ProtocolMessage<TPayload>, "id" | "timestamp">>): ProtocolMessage<TPayload> {
  return {
    version: PROTOCOL_VERSION,
    id: input.id ?? crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    room: input.room,
    from: input.from,
    to: input.to,
    payload: input.payload
  };
}

export function validatePayload(type: ProtocolType, payload: unknown): Record<string, unknown> {
  return payloadSchemas[type].parse(payload) as Record<string, unknown>;
}
