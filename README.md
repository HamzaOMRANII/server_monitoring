# server_monitoring

Alert-first server monitoring for the omranisystems fleet.

> **v1 scope.** This is the first draft. It implements the core loop
> (agent → central → alert → notify) plus a read-only dashboard and a
> settings screen for alert receivers. It is built **central + agent** from
> day one so it scales to a fleet; your current server is simply "agent #1".
>
> Deliberately **not** in v1: a raw web terminal. See [Security](#security).

## Architecture

```
  ┌─────────────┐   metrics (HTTPS + token)   ┌──────────────────────────┐
  │   agent     │  ─────────────────────────▶ │        central           │
  │ (each box)  │                             │  monitoring.omrani…com    │
  │             │                             │                          │
  │ collectors: │                             │  • ingest  (/api/ingest) │
  │  cpu/mem    │                             │  • alert engine (state)  │
  │  disk       │                             │  • notifier (mail/tg)    │
  │  pm2        │                             │  • dashboard (read-only) │
  │  nginx+ssl  │                             │  • settings (receivers)  │
  │  uptime     │                             │  • auth (login gate)     │
  └─────────────┘                             └──────────────────────────┘
```

- **agent** (`agent/`) — a thin Node process that samples the box every N
  seconds and POSTs a snapshot to central with a shared secret. Runs under
  pm2 on each monitored server.
- **central** (`central/`) — Express app. Receives snapshots, keeps recent
  history in memory, evaluates alert rules with a firing/recover state
  machine, sends notifications, and serves the dashboard + settings behind a
  login gate.

## The alert loop (the actual product)

For every incoming snapshot, each rule is evaluated:

1. value crosses its threshold → state goes `OK → FIRING`, fire **one**
   notification.
2. while `FIRING`, re-notify every `remindMinutes` (so you don't get spammed
   every sample, but you're not forgotten either).
3. value drops back under threshold → `FIRING → OK`, send a **recovered**
   notification.

State lives in `central/alerts.js`.

## Quick start (local dev)

```bash
npm install
cp config.example.json config.json   # then edit it
npm run central                       # starts the dashboard on :8080
npm run agent                         # in another shell, reports into central
```

Open http://localhost:8080 and log in with the password from `config.json`.

## Deploy sketch (production)

1. On the central host: run `central` under pm2, put nginx in front with TLS
   for `monitoring.omranisystems.com`.
2. On each monitored box: run `agent` under pm2 with `CENTRAL_URL` and the
   shared `INGEST_TOKEN` pointing at central.
3. **Lock it down** before exposing — see below.

## Security

This app sees your processes, your nginx routing, your IPs, and (later) your
logs. Treat it as sensitive infrastructure.

- **Login gate on everything.** The whole UI is behind a password session
  (`central/auth.js`). Set a strong password in `config.json`.
- **Agent → central is authenticated** with a shared `INGEST_TOKEN`. Rotate it
  if it leaks.
- **Read-only by default.** v1 has no state-changing actions exposed.
- **Recommended before going public:** terminate TLS at nginx, add an IP
  allowlist, and ideally keep the whole thing behind a VPN / Tailscale.
- **No raw terminal.** A password-gated web shell on a public URL is a
  fleet-wide RCE backdoor. The planned path is *scoped action buttons*
  (restart a pm2 app, reload nginx, tail a log) as named, audited operations —
  see `ROADMAP` below — not "type whatever you want".

## Roadmap

- **Core (this draft):** agent→central pipeline · CPU/RAM/disk threshold
  alerts with firing/recover state · receiver settings · read-only dashboard ·
  login gate.
- **Fast-follow:** scoped action buttons · uptime 200-check · live start/stop
  stream · log tail · persist history to SQLite.
- **Later:** multi-server fleet view · per-rule receiver routing · true
  terminal behind VPN (only if still wanted).

## Styling

The UI uses CSS custom properties in `public/styles.css` (`:root`). Swap those
tokens to match `it.omranisystems.com`. Nothing is hard-coded to a color.
