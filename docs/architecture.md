# Architecture

codex-coms is a Skills-first communication layer for two Codex agents working on two different computers.

The MVP has three runtime parts:

- Relay server: a WebSocket router that authenticates a room token, tracks connected agents per room, and forwards versioned JSON messages.
- Local sidecar: a process beside each workspace that connects to the relay, writes local inbox and audit files, enforces grants, serves read/list requests, and receives file transfers.
- CLI and Skill: the stable interface Codex and humans use. Codex calls `codex-coms` commands from `.agents/skills/codex-coms/SKILL.md`.

## Boundary

The relay never reads a workspace, writes files, executes commands, creates grants, or decides whether a file can be shared.

The sidecar is the security boundary. It decides which peer can read which local path, for how long, and under what size/list limits.

The Codex Skill is not a network protocol. It is durable workflow guidance that tells Codex which local CLI commands to run and how to treat peer messages safely.

## Runtime Flow

```text
Codex or human
  -> codex-coms CLI
  -> local sidecar or direct relay command
  -> WebSocket relay
  -> peer sidecar
  -> peer inbox, grants, transfer folder, audit log
```

Direct CLI commands such as `send`, `request-read`, `list-remote`, `read-remote`, and `send-file` open short-lived authenticated WebSocket connections. Long-running `connect` starts the sidecar that receives inbound messages and serves grants.

`connect` writes `.codex-coms/sidecar.pid` and refuses to start a duplicate sidecar unless `--replace` is passed. `status` compares config identity, runtime sidecar identity, and PID liveness so identity drift is visible.

## State Files

`codex-coms init` creates `.codex-coms/` in the workspace:

- `config.json`: local agent ID, workspace, relay URL, room, and token.
- `inbox.jsonl`: inbound messages and actionable events.
- `outbox.jsonl`: outbound message summaries.
- `grants.json`: local read-only grants.
- `audit.jsonl`: append-only local audit events.
- `status.json`: last known sidecar connection state.
- `transfers/`: received files, grouped by sender and transfer ID.

`config.json` and all `.codex-coms/**` files are denied by remote read filters.

## Message Routing

Messages include `version`, `type`, `id`, `room`, `from`, optional `to`, `timestamp`, and `payload`.

The relay accepts `hello` as the first message, checks the shared token, registers the connection, and sends `hello.ack`. Later frames must match the authenticated connection's `room` and `from` values.

The relay supports multiple sockets per agent. This lets a long-running sidecar and short-lived CLI command use the same agent ID.

## Grants

Grants are deny-by-default. A remote peer cannot list or read anything without an active grant for that peer and grant ID.

Grant checks enforce:

- Grant owner and target peer IDs.
- TTL expiration and revocation.
- Canonical path containment under the grant root.
- Workspace containment at grant creation.
- Default secret path denials.
- Read size and list count limits.

## File Transfer

File transfer uses `file.offer`, `file.accept`, `file.chunk`, and `file.complete`.

Received files are saved under `.codex-coms/transfers/<fromAgent>/<transferId>/`. Filenames are sanitized, existing files are never overwritten, content is hash-checked with SHA-256, and files are written with non-executable permissions.

## Wake Model

Codex is not assumed to passively listen. The stable MVP behavior is polling with `codex-coms inbox`.

`src/wake/codexWake.ts` contains an optional disabled-by-default wake helper. It can run a locally configured command with static local inputs only. Remote peers cannot choose the command or inject message text into shell execution.

For immediate local awareness, use `codex-coms wake notify`. For autonomous handling, configure a trusted local command that runs Codex non-interactively and checks `codex-coms inbox`. Existing Codex thread interruption remains a local Codex-app/automation concern, not a peer-controlled protocol feature.
