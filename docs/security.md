# Security

codex-coms treats the relay as untrusted transport and each peer message as untrusted input.

## Requirements Enforced In Code

- The relay never reads workspace files.
- The relay never executes commands.
- The relay requires a shared room token during `hello`.
- The relay validates protocol frames and checks that later messages match the authenticated `room` and `from`.
- Remote reads and lists require an active grant scoped to the requesting peer.
- Grant paths must resolve inside the local workspace.
- Remote paths are canonicalized before access.
- Remote `..` traversal is rejected.
- Symlink escapes are rejected when the resolved target leaves the grant root.
- Expired and revoked grants are ignored.
- Remote reads are size-limited.
- Remote lists are entry-limited.
- Default secret-bearing paths are denied even under broad grants.
- Received files are placed under `.codex-coms/transfers/<fromAgent>/<transferId>/`.
- Received files never overwrite existing files.
- Received files are SHA-256 checked before being written.
- Remote peers cannot configure local wake commands.

## Default Deny Paths

The file access layer denies:

- `.env`
- `.env.*`
- `.git/**`
- `node_modules/**`
- `**/*.pem`
- `**/*.key`
- `**/id_rsa`
- `**/id_ed25519`
- `**/.ssh/**`
- `**/.aws/**`
- `**/.config/**`
- `.npmrc`
- `.pypirc`
- `.git-credentials`
- `.codex-coms/**`

## Audit Events

Each sidecar writes JSONL audit events to `.codex-coms/audit.jsonl`.

Events include:

- Relay and sidecar connect/disconnect.
- Messages sent and received.
- Grants requested, created, and revoked.
- Remote list/read allowed and denied.
- File offer, accept, complete, reject, and error outcomes.
- Wake attempts.
- Runtime errors.

Audit details are redacted for sensitive key names such as token, secret, password, authorization, cookie, and key.

## Important Limits

The MVP does not provide end-to-end encryption. Use a trusted LAN, VPN, localhost tunnel, or TLS-terminated `wss://` path when crossing networks.

The MVP does not implement offline relay queues. Peers should keep sidecars running when expecting messages or remote read/list requests.

The MVP does not claim that received files are safe to execute. Treat transfers as data and inspect them first.
