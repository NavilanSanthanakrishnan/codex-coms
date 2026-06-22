# Codex Integration

codex-coms is Skills-first by design.

The repo includes `.agents/skills/codex-coms/SKILL.md`. Codex can load repo-scoped skills from `.agents/skills`, and skills are suitable for reusable task workflows. AGENTS.md is used for durable repository guidance, not as the live message channel.

## Intended Codex Workflow

1. User asks Codex to collaborate with another Codex agent.
2. Codex invokes the `codex-coms` skill.
3. Codex runs `codex-coms status`.
4. Codex runs `codex-coms inbox`.
5. Codex summarizes unread messages.
6. Codex sends small replies, asks for access, grants narrow access, or reads remote granted files with explicit CLI commands.

## Why Not MCP First

MCP is useful for exposing tools to clients, but this MVP needs a simple local developer workflow first. The durable interface for Codex is the Skill plus CLI commands.

A future MCP adapter could wrap the CLI or sidecar, but it should not move workspace authority into the relay.

## Codex Wake

Codex may not be passively listening. The sidecar stays online, and Codex checks messages by running the CLI.

The stable flow is:

```bash
codex-coms status
codex-coms inbox
```

Optional wake support is disabled by default. If enabled locally, wake can run only a locally configured command with static local inputs. Remote peer text is never interpolated into shell commands.

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
