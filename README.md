# zsh-web

> Multi-machine, multi-session shared terminals in your browser. Pick a **machine → session**, open a terminal, and connect from any device — every client stays **byte-for-byte in sync**.

**English** · [中文](README.zh-CN.md)

A lightweight, self-hosted terminal hub. The **Hub** runs on your server/NAS — it serves the web UI, handles login, and relays bytes; it never opens a shell itself. Each computer runs an **Agent** that dials *out* to the Hub, registers itself, and opens zsh locally on demand. Your phone, tablet, or another laptop can all attach to the same session and see exactly the same screen.

## Features

- 🖥️ **Multi-machine, multi-session** — manage every zsh session on every machine from one web page.
- 🔄 **Byte-level sync** — multiple clients on one session see identical I/O in real time; a newcomer instantly sees the current screen (scrollback cache).
- 🔌 **NAT-friendly** — Agents dial outbound, so only the Hub needs to be reachable; no inbound ports per machine.
- 💾 **Session persistence** — an Agent restart restores the session list and history (the shell itself is a fresh process).
- 🔐 **Two-layer auth** — browsers log in via OIDC SSO (e.g. Synology); machines authenticate with a one-time pairing token.
- 📱 **iOS app** — a native SwiftUI client (built on SwiftTerm) lives under `ios-hub/`.

## Architecture (Hub + Agent)

```
   Browser (any device) ──WSS + OIDC login──▶  Hub (server/NAS, Docker)
                                                 │  web + auth + machine registry + byte relay
                          Agent dials out ▲      │  (never opens a shell itself)
              ┌───────────────┬───────────────┘
              ▼               ▼
          Agent (Mac)    Agent (desktop) …   each opens local zsh PTYs, bridges them to the Hub
```

- **Hub** (`hub.js`) — serves the web UI, OIDC login, machine registration/pairing, and relays bytes between browser and target machine. It caches per-session scrollback (`SCROLLBACK` bytes) so a new browser sees the current screen on attach. No `node-pty` dependency (it opens no PTYs), so the container image is pure JS with no native build.
- **Agent** (`agent.js`) — one long-running process per computer. It dials `wss://<hub>/agent` (NAT-friendly: only the Hub must be reachable), owns the local sessions, and multiplexes them all over a single WebSocket. Exponential-backoff reconnect; graceful flush on SIGTERM.
- **Session core** (`sessions.js`) — each session is an independent zsh PTY; the replay buffer is throttled to disk under `SESSION_DIR` (default `./.sessions/` per machine). After an Agent restart the session list and history come back, but the shell is a new process (`cd`, background jobs, env vars are not preserved); a "service restarted" line is appended. Sessions you `exit` or delete have their archive removed at once.
  > ⚠️ What's persisted is raw terminal output (may contain commands / sensitive data), stored in plaintext under each machine's `SESSION_DIR`.

**Multiplexing protocol** (`wire.js`, one Agent↔Hub WS carries many sessions)

- Control frame = JSON text: `{t:"create|created|kill|resize|exit|sessions", sid?, ...}`
- Data frame = binary: `[8-byte sid][raw PTY bytes]` (session id is always 8 hex — a fixed-length prefix)

**Browser protocol** (`/ws?agent=<machine id>&session=<session id>`)

- shell output → browser: binary frames fed to xterm.js; keystrokes → shell: binary frames
- resize: JSON `{"type":"resize","cols":..,"rows":..}`

## Quick start

### 1. Deploy the Hub (Docker)

```bash
cp .env.example .env      # fill in AUTH_SECRET / OAUTH2_* etc. (see the table below)
docker compose up -d --build
```

`docker-compose.yml` brings up two containers (same image):

- **hub** → publishes `7654` (point your reverse proxy here), mounts `./data` for the machine registry.
- **usage** → internal `7655`, the Claude usage-monitoring service, reachable only by the hub over the compose network (no published port). Optional.

**Reverse proxy**: forward a whole subdomain to the Hub's `7654`, with **WebSocket pass-through enabled** and TLS terminated. The front end uses absolute paths (`/ws`, `/api`), so it **cannot live under a sub-path** — it must be a dedicated subdomain at the root.

**OIDC login** (Synology SSO as an example): create an app at your identity provider, then put the three endpoints and the Redirect URI into `.env`. The **Redirect URI must match exactly**; the scope depends on your provider (Synology supports only `openid email`, no `profile`).

### 2. Register a new computer (web pairing code)

```bash
# ① On the web UI (logged in) click "+ Add" → a one-time pairing code (5-min TTL by default)
# ② On the new computer (after npm install), run once:
HUB_URL=http://<your-hub-host>:7654 node agent.js pair <code> --name workstation
#    The Agent trades the code for a machine-specific long-lived credential at ~/.zshweb-agent.json
# ③ Afterwards `node agent.js` brings it online automatically (set up autostart, see below)
```

- Pairing code: held in Hub memory, single-use + TTL, generatable only by a logged-in user.
- Machine credential: the Hub issues one random token per machine and **stores only its hash**; revoking = deleting the registry record, which kicks the machine offline.
- Registry `data/machines.json` is on a mounted volume, so it survives container rebuilds.

### 3. Autostart the Agent on macOS (launchd)

```bash
# Pair once first; credentials land in ~/.zshweb-agent.json, then:
cp com.zshweb.agent.plist ~/Library/LaunchAgents/
launchctl load   ~/Library/LaunchAgents/com.zshweb.agent.plist   # start + autostart
launchctl unload ~/Library/LaunchAgents/com.zshweb.agent.plist   # stop
# After editing agent.js / the plist: unload, then load
```

> Edit `com.zshweb.agent.plist` and set `HUB_URL`, `MACHINE_NAME`, `SESSION_DIR`, `WorkingDirectory`, and the paths to your own.
> **macOS Full Disk Access**: the Agent will `cd` into Desktop/Documents etc., so grant your node binary (e.g. `/opt/homebrew/bin/node`) Full Disk Access, or macOS keeps prompting "node wants to access your data". A node upgrade changes the real path, so re-grant it.

## Environment variables

| Variable | Used by | Notes |
|------|------|------|
| `PORT` / `HOST` | Hub/Agent | Hub listen address (default `7654` / `0.0.0.0`) |
| `AUTH_SECRET` | Hub | cookie signing key; **keep it fixed** so logins survive restarts |
| `AUTH_TOKEN` | Hub | local CLI token login (optional; OAuth2 is the main path) |
| `OAUTH2_*` | Hub | OIDC app credentials + 3 endpoints + Redirect URI + scope |
| `DATA_DIR` | Hub | machine-registry directory (`/app/data` in the container, mounted) |
| `SCROLLBACK` | Hub/session | replay buffer size per session, in bytes |
| `USAGE_API_URL` | Hub | usage service address (`http://usage:7655` in compose) |
| `CC_PROXY` | usage | outbound proxy to reach Anthropic (optional), e.g. `http://user:pass@host:port` |
| `POLL_INTERVAL_MS` | usage | usage poll interval in ms (default 5 min) |
| `HUB_URL` | Agent | Hub address (e.g. `http://<your-hub-host>:7654`) |
| `MACHINE_NAME` | Agent | display name (default: hostname) |
| `SESSION_DIR` / `PERSIST_MS` | Agent/session | history dir / write-throttle ms (default 2000) |
| `AGENT_STORE` | Agent | credential file (default `~/.zshweb-agent.json`) |

## REST / WS reference

| Method | Path | Purpose |
|------|------|------|
| POST | `/api/pair/new` | (logged in) generate a one-time pairing code |
| POST | `/agent/pair` | (no browser auth) Agent trades a code for its token |
| GET/DELETE | `/api/agents` `/api/agents/:id` | list / revoke machines |
| GET/POST | `/api/agents/:id/sessions` | list / create sessions on a machine |
| DELETE | `/api/agents/:id/sessions/:sid` | kill a session |
| GET | `/api/me` `/api/usage` | current user / usage (proxied to the usage service) |
| WS | `/agent?token=&machine=` | Agent dial-in (machine-token auth) |
| WS | `/ws?agent=&session=` | browser attaches to a machine's session (login required) |

## Troubleshooting

- **Web shows "reconnecting…"** — the reverse proxy isn't passing WebSockets → check that rule's WebSocket toggle.
- **A machine stays offline** — the Agent can't reach the Hub → check `HUB_URL` reachability and that the credential isn't revoked; see `zsh-web-agent.log`.
- **New session fails / machine offline** — that machine's Agent isn't running or just dropped (the Hub timed out waiting for its ack).
- **Usage 502** — the usage container isn't up or is misconfigured → `docker compose ps` / check logs.
- **OIDC login stuck at callback** — usually a Redirect URI mismatch or a wrong client secret.
- **"node wants to access your data" again** — a node upgrade broke Full Disk Access; re-grant it.

## Project layout

```
hub.js            Hub: web + auth + machine registry + byte relay
agent.js          Agent: one resident process per machine, dials the Hub
sessions.js       session core: one zsh PTY per session + persistence
wire.js           Agent↔Hub multiplexing wire protocol
auth.js           OIDC / token login
usage/            Claude usage-monitoring service (optional)
public/           front end (xterm.js)
ios-hub/          native iOS client (SwiftUI + SwiftTerm)
server.js         legacy single-host mode (web + local PTY in one process; to be retired)
client.js         legacy single-host local terminal viewer
```

> **Legacy single-host mode**: `server.js` / `client.js` are the pre-Hub+Agent single-machine version (web and shell on one host), kept for reference and removable when you don't need them.

## License

MIT
