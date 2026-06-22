# Two Agents Local Example

This example runs both agents on one computer. Use it to verify the workflow before trying a second machine.

## Terminal 1

```bash
npm install
npm run build
TOKEN=$(openssl rand -hex 32)
npx codex-coms relay --host 127.0.0.1 --port 8787 --token "$TOKEN"
```

Keep this terminal open.

## Terminal 2

```bash
mkdir -p /tmp/codex-coms-alice
cd /tmp/codex-coms-alice
npx /path/to/codex-coms init --agent alice --workspace "$PWD" --relay ws://127.0.0.1:8787 --room demo --token "$TOKEN"
npx /path/to/codex-coms connect --relay ws://127.0.0.1:8787 --room demo --agent alice --token "$TOKEN" --workspace "$PWD"
```

Keep this terminal open.

## Terminal 3

```bash
mkdir -p /tmp/codex-coms-bob/notes
printf 'hello from bob notes\n' > /tmp/codex-coms-bob/notes/context.txt
cd /tmp/codex-coms-bob
npx /path/to/codex-coms init --agent bob --workspace "$PWD" --relay ws://127.0.0.1:8787 --room demo --token "$TOKEN"
npx /path/to/codex-coms connect --relay ws://127.0.0.1:8787 --room demo --agent bob --token "$TOKEN" --workspace "$PWD"
```

Keep this terminal open.

## Terminal 4

```bash
cd /tmp/codex-coms-alice
npx /path/to/codex-coms send --to bob --text "Can I read your notes/context.txt?"
```

Bob checks:

```bash
cd /tmp/codex-coms-bob
npx /path/to/codex-coms inbox
npx /path/to/codex-coms grant --to alice --path notes --name notes --ttl 2h
```

Alice lists and reads:

```bash
cd /tmp/codex-coms-alice
npx /path/to/codex-coms inbox
npx /path/to/codex-coms list-remote --from bob --grant <grantId> --path .
npx /path/to/codex-coms read-remote --from bob --grant <grantId> --path context.txt
```

Alice sends a file:

```bash
printf 'handoff\n' > /tmp/codex-coms-alice/handoff.txt
npx /path/to/codex-coms send-file --to bob --path handoff.txt
```

Bob receives it under `.codex-coms/transfers/alice/<transferId>/`.
