# Codex Integration

codex-coms is Skills-first by design.

The repo includes `.agents/skills/codex-coms/SKILL.md`. Codex can load repo-scoped skills from `.agents/skills`, and skills are suitable for reusable task workflows. AGENTS.md is used for durable repository guidance, not as the live message channel.

## Intended Codex Workflow

1. User asks Codex to collaborate with another Codex agent.
2. Codex invokes the `codex-coms` skill.
3. Codex runs `codex-coms status`.
4. Codex runs `codex-coms status --peers` when it needs to know whether the peer sidecar is online.
5. Codex runs `codex-coms inbox`.
6. Codex summarizes unread messages.
7. Codex sends small replies, asks for access, grants narrow access, or reads remote granted files with explicit CLI commands.

For ongoing collaboration, keep the sidecar online:

```bash
codex-coms connect --daemon --workspace "$PWD"
```

Run this after `codex-coms init` so saved config supplies relay, room, agent ID, and token. This avoids repeating the token in long-lived process arguments.

Daemon mode retries relay connection failures, so transient tunnel or network drops should become local sidecar log entries instead of silent collaboration outages.

## Why Not MCP First

MCP is useful for exposing tools to clients, but this MVP needs a simple local developer workflow first. The durable interface for Codex is the Skill plus CLI commands.

A future MCP adapter could wrap the CLI or sidecar, but it should not move workspace authority into the relay.

## Codex Wake

Codex may not be passively listening. The sidecar stays online and records inbound events immediately, so Codex does not need to constantly poll raw inbox state.

The manual flow is still:

```bash
codex-coms status
codex-coms inbox
codex-coms inbox --mark-read
```

`codex-coms status` also reports how many pending wake events have not yet attempted the configured wake command, which event is next, and whether a wake command lock is live or stale, so a local adapter can decide whether `codex-coms wake trigger --json` has useful work without first calling `wake queue`.

When the manual flow marks displayed messages read, codex-coms also drains the matching pending wake events so already-handled messages do not keep appearing as local wake work.

Every inbound inbox event also creates a local wake event. Wake events are durable local metadata: sender, event type, priority, summary, inbox entry ID, and local file paths. A trusted local thread, automation, or `codex exec` wrapper can claim those events:

```bash
codex-coms wake queue
codex-coms wake drain --json
codex-coms wake drain --event <wakeOrInboxId> --json
codex-coms wake wait --json
codex-coms wake trigger --json
```

Optional command wake support is disabled by default. If enabled locally, wake can run only a locally configured command with static local inputs plus local event paths and environment metadata. Remote peer text is never interpolated into shell commands.

Available wake modes:

- `codex-coms wake wait --json`: block a local adapter until wake events arrive, then claim those events without repeatedly checking raw inbox state.
- `codex-coms wake drain --event <wakeOrInboxId> --json`: claim the exact pending event a local adapter is handling, without claiming unrelated wake work from another thread.
- `codex-coms wake trigger --json`: after a local wake command is configured, start it for the next pending wake event that has not already attempted one. This is useful when the adapter or Codex thread comes back after events were already queued. Pass `--event <wakeOrInboxId>` when a local adapter needs to target one pending event, `--all` when concurrent wake is enabled and every eligible pending event should get its own command, and `--retry-attempted` only when the local wake command was fixed and an attempted pending event should be tried again.
- `codex-coms connect`: after the sidecar connects, it tries one local catch-up wake command for an existing pending unattempted wake event, so a recovered sidecar does not need a separate cron tick just to resume queued work.
- `codex-coms wake notify`: show a local macOS notification when an inbox event arrives.
- `codex-coms wake command /absolute/path [args...] --prompt "<static prompt>"`: run a local command chosen by the user. Configuration tries one local catch-up wake command for an existing pending unattempted event. The command receives static args and, by default, the local wake event JSON path as the final argument. It also receives `CODEX_COMS_WAKE_EVENT_PATH`, `CODEX_COMS_WAKE_FROM`, `CODEX_COMS_WAKE_TYPE`, and related metadata in the environment. Wake commands are single-flight by default: if a previous handler process is still running, new events stay queued and no duplicate handler is spawned. Pass `--allow-concurrent` when one process per event is intentional.

This is intentionally not remote thread interruption. A peer message can wake local plumbing, but it cannot choose a Codex command, shell text, or thread. A local adapter decides whether to interrupt an active low-priority task, steer an existing thread, or wake an inactive thread.

## Agent IDs

Protocol IDs are wire IDs and cannot contain spaces. Use IDs such as:

- `shreyagent`
- `navagent`
- `alice`
- `bob`

Use display names such as “Shrey Agent” or “Nav Agent” only in human-facing text.

## Official Codex Context Used

The implementation direction follows the current Codex manual guidance that:

- Skills package reusable workflows and are available in Codex surfaces.
- AGENTS.md is startup/project guidance.
- `codex exec` is useful for non-interactive runs.
- Automations can combine with skills later but are not required for this MVP.
- Native Codex subagents are parent-orchestrated parallel workers, not a peer-to-peer durable message bus.

Relevant docs:

- [Agent Skills](https://developers.openai.com/codex/skills)
- [AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Automations](https://developers.openai.com/codex/app/automations)
- [Subagents](https://developers.openai.com/codex/subagents)
