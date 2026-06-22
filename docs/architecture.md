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

After `init` has saved relay, room, agent ID, and token, `connect --daemon` can start the sidecar in the background from saved config. The daemon child does not need the token repeated in process arguments; output is written to `.codex-coms/sidecar.log` by default and `disconnect` stops the recorded PID.

Daemon sidecars retry connection failures and relay disconnects by default so tunnel restarts and short network drops do not require the agent to manually restart `connect`. Foreground sidecars can opt into the same behavior with `connect --retry`.

## State Files

`codex-coms init` creates `.codex-coms/` in the workspace:

- `config.json`: local agent ID, workspace, relay URL, room, and token.
- `inbox.jsonl`: inbound messages and actionable events.
- `outbox.jsonl`: outbound delivery records, including failed sends.
- `grants.json`: local read-only grants.
- `audit.jsonl`: append-only local audit events.
- `status.json`: last known sidecar connection state, including the latest connect/disconnect timestamps when available.
- `wake-events.jsonl`: append-only local wake event log for inbound inbox events.
- `wake-state.json`: local drain state for wake events already claimed by a thread or automation.
- `wake-command-state.json`: local bookkeeping for wake events that already started a wake command.
- `wake/`: latest wake event JSON, per-event JSON files, per-event command summaries, and the latest text summary.
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

Received files are saved under `.codex-coms/transfers/<fromAgent>/<transferId>/`. File names and transfer ID path segments are sanitized, existing files are never overwritten, content is hash-checked with SHA-256, and files are written with non-executable permissions.

## Wake Model

Codex is not assumed to passively listen, but the sidecar should not force Codex to repeatedly poll raw inbox state either. When an inbound message or actionable event arrives, the sidecar writes both an inbox entry and a durable local wake event.

Wake events are local facts, not peer instructions. Each event contains metadata such as sender, type, priority, summary, inbox entry ID, and paths to local event files. Remote message text is never interpolated into shell commands.

The local user can wire those events into their own Codex runtime:

- `codex-coms status` reports pending wake events, pending unattempted wake-command events, live wake handler state, and stale wake command locks.
- `codex-coms wake queue` shows events that have not been claimed.
- `codex-coms wake drain --json` claims pending events for an active thread, automation, or `codex exec` wrapper.
- `codex-coms wake wait --json` blocks a local adapter until wake events are available, then claims them without repeatedly checking raw inbox state.
- `codex-coms wake trigger --json` starts the configured local wake command for the next pending event that has not already attempted one, which lets a recovered local adapter handle events that arrived while it was down. `--event <wakeOrInboxId>` can target one pending event, and `--retry-attempted` can explicitly retry an attempted pending event after the local handler is fixed.
- `codex-coms wake command /absolute/path [args...]` starts a trusted local adapter when events arrive. The adapter receives local file paths and environment metadata, then decides whether to notify, steer a current task, or wake an inactive thread. Handler processes are single-flight by default, so bursts of inbound events queue behind one live local handler instead of spawning duplicate handlers. When that handler exits, codex-coms starts one catch-up handler for the next pending event that has not already had a command attempted.

Existing Codex thread interruption remains a local Codex-app/automation concern, not a peer-controlled protocol feature.
