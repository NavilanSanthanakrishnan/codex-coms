# codex-coms

codex-coms is a Skills-first communication layer that lets two Codex agents on different computers talk over WebSocket, exchange messages, transfer files, and grant scoped read-only access to selected workspace files.

The relay routes messages only. Each local sidecar is the security gatekeeper for its own workspace.

## Requirements

- Node.js 22.12.0 or newer.
- npm with lockfile v3 support, such as the npm bundled with current Node.js releases.

## Two-Computer Quickstart

Computer A:

```bash
git clone https://github.com/NavilanSanthanakrishnan/codex-coms
cd codex-coms
npm install
npm run build
TOKEN=$(openssl rand -hex 32)
npx codex-coms relay --host 0.0.0.0 --port 8787 --token "$TOKEN"
```

Computer A sidecar, in the workspace Alice wants to share from:

```bash
cd /path/to/alice-workspace
npx /path/to/codex-coms init --agent alice --workspace "$PWD" --relay ws://HOST_OR_LAN_IP:8787 --room pair --token "$TOKEN"
npx /path/to/codex-coms connect --relay ws://HOST_OR_LAN_IP:8787 --room pair --agent alice --token "$TOKEN" --workspace "$PWD"
```

After `init`, later sidecar starts can use saved config without putting the room token in the process arguments:

```bash
codex-coms connect --daemon --workspace "$PWD"
codex-coms status
codex-coms disconnect
```

Daemon sidecars keep retrying when the relay is temporarily unavailable. Tune retry speed with `--retry-delay-ms <ms>`.

Computer B sidecar, in Bob's workspace:

```bash
git clone https://github.com/NavilanSanthanakrishnan/codex-coms
cd codex-coms
npm install
npm run build
cd /path/to/bob-workspace
npx /path/to/codex-coms init --agent bob --workspace "$PWD" --relay ws://HOST_OR_LAN_IP:8787 --room pair --token "$TOKEN"
npx /path/to/codex-coms connect --relay ws://HOST_OR_LAN_IP:8787 --room pair --agent bob --token "$TOKEN" --workspace "$PWD"
```

Alice sends Bob a message:

```bash
codex-coms send --to bob --text "Can you grant notes/context.md?" --wait-ms 10000
```

Bob checks and grants a narrow path:

```bash
codex-coms inbox
codex-coms grant --to alice --path notes/context.md --name context --ttl 2h
```

Alice reads through the grant:

```bash
codex-coms inbox
codex-coms list-remote --from bob --grant <grantId> --path .
codex-coms read-remote --from bob --grant <grantId> --path .
```

## Local Demo

```bash
npm run demo
```

The demo starts a relay, creates Alice and Bob temp workspaces, sends a message, creates a grant, reads a granted file, proves `../secret.txt` is denied, transfers a file, and verifies audit logs exist.

## Packaging

`npm pack` and `npm publish` run `npm run build` through the `prepack` script, so runtime package artifacts are generated from the current source before npm assembles the tarball. The build removes stale `dist` output, emits only `dist/src`, and marks `dist/src/cli.js` executable for local `npm link` and direct bin usage. `npm run typecheck` still checks source, tests, and config without emitting files.

## CLI Commands

- `codex-coms relay --host 127.0.0.1 --port 8787 --token <token>` starts the relay.
- `codex-coms init --agent <agentId> --workspace <path>` creates local state.
- `codex-coms connect --relay <url> --room <room> --agent <agentId> --token <token> --workspace <path>` starts a sidecar.
- `codex-coms connect --daemon --workspace <path>` starts a background sidecar from saved config, writes `.codex-coms/sidecar.log`, and retries relay connection failures.
- `codex-coms connect --retry --workspace <path>` keeps a foreground sidecar reconnecting after relay drops.
- `codex-coms connect --replace ...` stops the recorded sidecar PID before reconnecting.
- `codex-coms disconnect` stops the recorded sidecar process for the workspace.
- `codex-coms rename --agent <agentId> --display-name "Human Name"` updates the local wire ID after the sidecar is stopped.
- `codex-coms send --to <agentId> --text "message"` sends a peer message.
- `codex-coms send --to <agentId> --text "message" --wait-ms 10000` waits for the target sidecar before sending.
- `codex-coms inbox` prints unread messages.
- `codex-coms inbox --json` prints machine-readable inbox entries.
- `codex-coms inbox --mark-read` marks displayed messages read and drains matching pending wake events.
- `codex-coms outbox` prints outbound delivery records.
- `codex-coms outbox --failed --json` prints machine-readable failed send records.
- `codex-coms grant --to <agentId> --path <path> --name <name> --ttl 2h` creates a read-only grant.
- `codex-coms revoke --grant <grantId>` revokes a grant.
- `codex-coms request-read --to <agentId> --path <path> --reason "why"` asks a peer for access.
- `codex-coms list-remote --from <agentId> --grant <grantId> --path <relativePath>` lists a granted remote path.
- `codex-coms read-remote --from <agentId> --grant <grantId> --path <relativePath>` reads a granted remote file.
- `codex-coms send-file --to <agentId> --path <path>` transfers a file safely.
- `codex-coms status` shows local state, including sidecar timing, next pending wake-command work, and wake-handler lock state when available.
- `codex-coms status --peers` asks the relay which agents are connected in the room, including relay-observed peer `connectedAt` and `lastSeenAt` timestamps when the relay provides them.
- `codex-coms wake notify` enables a local macOS notification for inbound inbox events and tries one local catch-up command for existing pending wake work.
- `codex-coms wake queue` shows pending local wake events.
- `codex-coms wake drain --json` claims pending wake events for a local thread, automation, or `codex exec` wrapper. Pass `--event <wakeOrInboxId>` to claim the exact event that woke a local adapter.
- `codex-coms wake wait --json` blocks until local wake events are available, then claims them for a local adapter.
- `codex-coms wake trigger --json` starts the configured local wake command for the next pending wake event that has not already attempted one. Pass `--event <wakeOrInboxId>` to target a specific pending event, `--all` to start all eligible pending events when concurrent wake is enabled, or `--retry-attempted` to retry an attempted pending event after fixing local wake configuration.
- `codex-coms wake command /absolute/path [args...]` runs a locally chosen command for inbound events and passes the local wake event JSON path as the final argument by default. When configured, it tries one local catch-up command for existing pending wake work. Wake commands are single-flight by default: if a previous handler process is still running, new events stay queued and no duplicate handler is spawned; when the handler exits, the next pending unattempted event gets one catch-up command. `codex-coms connect` also tries one local catch-up command after connecting when pending unattempted wake events already exist. Pass `--allow-concurrent` when one process per event is intentional.
- `codex-coms wake disable` disables wake behavior.
- `codex-coms demo` runs the local simulation.

Wire agent IDs cannot contain spaces. Use IDs such as `shreyagent` and `navagent`; use display names for human-facing labels.

The relay does not queue offline inboxes. If `send` says the target is offline, the peer must keep `codex-coms connect` running. Use `send --wait-ms <ms>` when the target sidecar may be starting or reconnecting.

## Runtime Defaults

- Default data directory: `.codex-coms`.
- Default room for `init`: `default`.
- Relay port in examples: `8787`.
- Max WebSocket frame payload: 2 MiB.
- Max file transfer size: 10 MiB.
- File transfer chunk size: 64 KiB.
- Max remote read size per grant: 1 MiB.
- Max remote list entries per grant: 200.
- Wake support: disabled by default.

## Code Map

### Root Files

- `package.json`: npm package metadata, CLI bin mapping, runtime dependencies, and scripts.
  - `build`: compiles runtime TypeScript into `dist/src` and marks the generated CLI executable.
  - `prepack`: builds `dist/src` before npm packs or publishes the package.
- `package-lock.json`: npm dependency lockfile.
- `scripts/clean-dist.mjs`: removes stale `dist` output before package builds.
- `scripts/mark-cli-executable.mjs`: restores executable permissions on the generated CLI after TypeScript emits it.
- `tsconfig.json`: repo-wide TypeScript settings used by `npm run typecheck` for source, tests, and config.
- `tsconfig.build.json`: build-only TypeScript config that emits runtime `src` files without test or Vitest config artifacts.
- `vitest.config.ts`: Vitest test discovery and timeout settings.
- `.gitignore`: excludes dependencies, build output, coverage, logs, and local `.codex-coms` state.
- `AGENTS.md`: repository guidance for Codex.
- `README.md`: this code map and user guide.

### Documentation

- `docs/architecture.md`: runtime architecture, trust boundaries, state files, grants, transfer, and wake model.
- `docs/protocol.md`: versioned WebSocket message schema and message type reference.
- `docs/security.md`: enforced security properties, deny paths, audit behavior, and MVP limits.
- `docs/codex-integration.md`: Skill-first Codex workflow and rationale for not making MCP the first interface.
- `docs/networking.md`: localhost, LAN, VPN, tunnel, and token handling guidance.
- `examples/two-agents.local.md`: manual local two-agent walkthrough.

### Codex Skill

- `.agents/skills/codex-coms/SKILL.md`: repo-scoped Skill metadata, trigger rules, workflow, and safety instructions for Codex agents using this CLI.

### Source Files

- `src/index.ts`: public package barrel that exports protocol, relay, peer client, and config APIs.
- `src/cli.ts`: Commander CLI entrypoint.
  - `workspaceFromOptions`: resolves the workspace for a command.
  - `dataDirFromOptions`: resolves the local state directory.
  - `loadCliConfig`: loads `.codex-coms/config.json` for a command.
  - Command handlers implement `relay`, `init`, `connect`, `disconnect`, `rename`, `send`, `inbox`, `grant`, `revoke`, `request-read`, `list-remote`, `read-remote`, `send-file`, `status`, `wake`, and `demo`.
- `src/config.ts`: local configuration and state file helpers.
  - `resolveWorkspace`: normalizes a workspace path.
  - `resolveDataDir`: resolves `.codex-coms` or an override.
  - `readJson`: reads JSON with a fallback.
  - `writeJson`: writes formatted JSON.
  - `initWorkspace`: creates config, inbox, outbox, grants, audit, status, and transfer files.
  - `loadConfig`: loads local config.
  - `saveConfig`: writes local config.
  - `updateConfig`: merges and saves config updates.
  - `validateAgentId`: rejects wire IDs with spaces or unsafe characters.
  - `loadRuntimeStatus`: reads sidecar status, including connection timestamps.
  - `setRuntimeStatus`: writes sidecar status.
- `src/protocol/types.ts`: protocol type constants and shared TypeScript interfaces.
- `src/protocol/schema.ts`: zod schemas for every protocol payload and base envelope.
  - `parseProtocolMessage`: validates and returns a protocol message.
  - `safeParseProtocolMessage`: safe-parse variant.
  - `makeProtocolMessage`: fills protocol version, ID, and timestamp.
  - `validatePayload`: validates a payload by message type.
- `src/relay/server.ts`: WebSocket relay server.
  - `RelayServer.start`: starts HTTP and WebSocket listeners.
  - `RelayServer.stop`: closes sockets and servers.
  - `RelayServer.url`: returns the started relay URL.
  - Internal methods register, unregister, validate, route, and send errors.
  - `startRelayServer`: convenience constructor and start helper.
- `src/peer/client.ts`: client connection helpers and sidecar implementation.
  - `ProtocolConnection.open`: opens a WebSocket connection and performs `hello`.
  - `ProtocolConnection.send`: sends a validated protocol message.
  - `ProtocolConnection.waitFor`: waits for a matching response and fails fast if the socket closes.
  - `ProtocolConnection.close`: closes the socket.
  - `sendProtocolMessage`: sends one short-lived command message.
  - `requestProtocolResponse`: sends one command and waits for a correlated response.
  - `sendAgentMessage`: sends an `agent.message`, waits for peer acknowledgement, and writes local outbox/audit entries.
  - `requestRoomPeers`: asks the relay for connected room members and relay-observed freshness timestamps when available.
  - `sendFileToPeer`: sends a file offer, chunks, and completion frame.
  - `PeerSidecar.start`: connects the long-running sidecar, tries one local wake-command catch-up, and starts handling inbound messages.
  - `PeerSidecar.waitForClose`: waits until the sidecar socket closes.
  - `PeerSidecar.stop`: closes the sidecar.
  - Sidecar handlers write inbox entries, enforce grants, serve read/list responses, receive files, and log errors.
  - `parseListResponse`: validates list responses.
  - `parseReadResponse`: validates read responses.
- `src/peer/inbox.ts`: JSONL inbox and outbox helpers.
  - `appendInboxEntry`: appends one inbox entry.
  - `appendOutboxEntry`: appends one outbox entry.
  - `readInboxEntries`: reads JSONL inbox entries.
  - `readOutboxEntries`: reads JSONL outbox entries.
  - `markInboxRead`: rewrites inbox entries as read while holding the inbox write lock.
  - `formatInbox`: creates Codex-friendly text output.
  - `formatOutbox`: creates Codex-friendly text output for outbound records.
- `src/peer/pid.ts`: sidecar PID helpers.
  - `sidecarPidPath`: resolves `.codex-coms/sidecar.pid`.
  - `readSidecarPid`: reads the sidecar PID if present.
  - `isProcessRunning`: checks PID liveness.
  - `writeSidecarPid`: writes the current sidecar PID.
  - `clearSidecarPid`: removes the PID file when it belongs to the exiting process.
  - `ensureNoDuplicateSidecar`: refuses duplicate sidecars or terminates the old one when `--replace` is used.
- `src/workspace/grants.ts`: persisted read-only grant management.
  - `parseTtl`: parses TTL strings such as `2h`.
  - `loadGrants`: reads grants.
  - `saveGrants`: writes grants.
  - `isGrantActive`: checks TTL and revocation.
  - `createGrant`: creates a scoped grant inside the workspace.
  - `revokeGrant`: marks a grant revoked.
  - `findUsableGrant`: finds an active grant for a requester.
- `src/workspace/fsAccess.ts`: secure read/list enforcement.
  - `FsAccessError`: security-aware access error.
  - `isSubpath`: checks path containment.
  - `isDeniedSecretPath`: applies default deny rules.
  - `listGrantedPath`: lists a granted path with bounds and secret filtering.
  - `readGrantedFile`: reads a granted file with size and hash metadata.
- `src/workspace/snapshot.ts`: safe workspace summary helper.
  - `createWorkspaceSnapshotSummary`: summarizes visible root entries while skipping denied paths.
- `src/transfer/fileTransfer.ts`: file transfer preparation and receipt.
  - `sanitizeFilename`: strips unsafe filename characters.
  - `sanitizeTransferId`: strips unsafe transfer ID path characters before creating receive directories.
  - `prepareFileTransfer`: reads a file, hashes it, and splits it into base64 chunks.
  - `FileTransferReceiver.acceptOffer`: validates and records an incoming offer.
  - `FileTransferReceiver.receiveChunk`: stores an incoming chunk in memory.
  - `FileTransferReceiver.complete`: validates hash/size and writes the received file safely.
- `src/audit/auditLog.ts`: audit logging.
  - `redactSensitive`: recursively redacts sensitive-looking keys.
  - `appendAudit`: appends a redacted JSONL audit event.
  - `readAuditLog`: reads audit events.
- `src/wake/codexWake.ts`: optional wake helper.
  - `dispatchWakeEvent`: records a durable local wake event and optionally invokes a configured local command.
  - `readPendingWakeEvents`: returns wake events not yet claimed by a local thread or automation.
  - `readWakeCommandStatus`: reports pending wake events, next pending wake-command work, wake handler liveness, and stale command-lock state.
  - `markWakeEventsDrained`: marks wake events as claimed.
  - `drainWakeEventById`: claims one pending wake event by local wake ID or inbox entry ID.
  - `drainWakeEventsForInboxEntries`: claims pending wake events tied to handled inbox entries.
  - `waitForPendingWakeEvents`: blocks until wake events are available, then claims them.
  - `triggerPendingWakeCommand`: starts the configured local wake command for the next pending unattempted event, optionally targeting a specific wake/inbox ID or explicitly retrying an attempted pending event.
  - `triggerPendingWakeCommands`: starts configured local wake commands for all eligible pending events when concurrent wake is enabled.
  - `maybeWakeCodex`: no-ops by default or runs a locally configured static command with local event paths and metadata.
  - `writeInboxSummary`: writes per-event summary files and a latest summary file for wake commands to inspect.
- `src/demo/runDemo.ts`: end-to-end local simulation.
  - `runDemo`: starts relay and sidecars, sends a message, grants access, reads remotely, verifies denial, transfers a file, and returns a structured result.

### Tests

- `test/inbox.test.ts`: verifies inbox append and mark-read updates share a lock so manual reads do not overwrite concurrent sidecar appends.
- `test/cli.test.ts`: verifies delayed sidecar send waiting, failed-send outbox filtering, and status summary JSON.
- `test/protocol.test.ts`: validates happy-path protocol messages and malformed envelope/payload rejection.
- `test/grants.test.ts`: covers grant creation, allowed list/read, traversal denial, secret-file denial, revocation, and peer scoping.
- `test/relay.test.ts`: starts a relay on a random local port, checks same-room message routing, bad-token rejection, peer listing, and failed-send audit/outbox behavior.
- `test/transfer.test.ts`: verifies unsafe transfer IDs cannot place received files outside the transfer folder.
- `test/wake.test.ts`: verifies sidecar wake-event queueing and locally configured wake command metadata.
- `test/daemon.test.ts`: verifies daemon sidecar startup from saved config without token arguments.
- `test/demo.test.ts`: runs `runDemo` and verifies message delivery, remote read success, outside-read denial, file transfer, and audit log output.
