# Networking

codex-coms works anywhere both sidecars can reach the same relay WebSocket URL.

## Localhost

Use localhost for one-machine demos:

```bash
TOKEN=$(openssl rand -hex 32)
npx codex-coms relay --host 127.0.0.1 --port 8787 --token "$TOKEN"
```

Both sidecars connect to `ws://127.0.0.1:8787`.

## LAN

Run the relay on one computer:

```bash
TOKEN=$(openssl rand -hex 32)
npx codex-coms relay --host 0.0.0.0 --port 8787 --token "$TOKEN"
```

Find that computer's LAN IP and have both sidecars connect to `ws://LAN_IP:8787`.

## VPN Or Tunnel

For different networks, put the relay behind a VPN or tunnel. Prefer `wss://` when traffic leaves a trusted network.

Examples that can work depending on your environment:

- Tailscale or another private VPN.
- SSH tunnel from the friend computer to the host.
- A TLS-terminating reverse proxy in front of the relay.

For a quick cross-network test, Cloudflare Tunnel can expose the local relay:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Share the printed `https://...trycloudflare.com` URL as `wss://...trycloudflare.com` for codex-coms clients.

## Token Handling

Generate a fresh room token per collaboration session.

Do not paste the token into chat logs, docs, or product issues. The relay only needs it in the `hello` frame. Status output reports only whether a token is configured.
