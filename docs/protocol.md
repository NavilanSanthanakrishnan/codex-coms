# Protocol

codex-coms uses versioned JSON WebSocket messages validated with zod.

Every message has this shape:

```json
{
  "version": 1,
  "type": "agent.message",
  "id": "message-id",
  "room": "room-name",
  "from": "alice",
  "to": "bob",
  "timestamp": "2026-06-22T00:00:00.000Z",
  "payload": {}
}
```

`to` is required for routed messages. `hello` is the first client message and does not need `to`.

## Message Types

- `hello`: authenticate to the relay. Payload includes `token`, `kind`, and `capabilities`.
- `hello.ack`: relay acceptance. Payload includes `accepted` and `agentCount`.
- `agent.message`: human-readable peer message. Payload includes `text`.
- `agent.message.ack`: peer receipt notice. Payload includes `messageId`.
- `workspace.grant.request`: request read access. Payload includes `path` and `reason`.
- `workspace.grant.created`: notify a peer that a grant exists. Payload includes `grantId`, `name`, `path`, `expiresAt`, `maxReadBytes`, and `maxListEntries`.
- `workspace.grant.revoked`: notify a peer that a grant was revoked. Payload includes `grantId`.
- `workspace.list.request`: ask the granting sidecar to list a granted path. Payload includes `grantId` and `path`.
- `workspace.list.response`: list result. Payload includes `requestId`, `ok`, and either `entries` or `error`.
- `workspace.read.request`: ask the granting sidecar to read a granted file. Payload includes `grantId` and `path`.
- `workspace.read.response`: read result. Payload includes `requestId`, `ok`, and either file metadata plus `contentBase64` or `error`.
- `file.offer`: start a file transfer. Payload includes `transferId`, `filename`, `size`, `sha256`, `chunkSize`, and `chunkCount`.
- `file.accept`: accept or reject a file offer. Payload includes `transferId`, `accepted`, and optional `reason`.
- `file.chunk`: transfer one base64 chunk. Payload includes `transferId`, `index`, and `dataBase64`.
- `file.complete`: finish a transfer. Payload includes `transferId`.
- `error`: protocol or routing error. Payload includes `code`, `message`, and optional `requestId`.

## Relay Rules

The relay validates each frame before routing.

- First frame must be `hello`.
- The shared room token is checked only in `hello`.
- Tokens are not logged.
- Later frames must match the authenticated connection's `room` and `from`.
- Frames without a connected target receive an `error`.
- The relay does not interpret grant or file payloads beyond schema validation and routing.

## Request And Response Correlation

Remote read/list requests use the request message `id` as the response `payload.requestId`.

CLI commands wait for:

- `workspace.list.response` for `list-remote`.
- `workspace.read.response` for `read-remote`.
- `file.accept` for `send-file`.
- `error` with matching `requestId` for failures.

## Size Limits

The WebSocket server uses a 2 MiB max frame payload. File transfer chunks default to 64 KiB. Total file transfer size defaults to 10 MiB.
