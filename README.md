# server_monitoring

Alert-first server monitoring for the Omrani Systems fleet —
**monitoring.omranisystems.com**.

Built on the **same stack as it.omranisystems.com**: a React 19 + Vite 8
client, served in production by a zero-dependency Node `http` server behind
nginx. The only runtime dependency is `nodemailer` (email alerts).

> **v1 scope.** Core loop (agent → central → alert → email) plus a read-only
> dashboard and a settings screen for thresholds + the email receiver. Built
> **central + agent** from day one so it scales to a fleet; your current
> server is simply "agent #1".
>
> Deliberately **not** in v1: a raw web terminal. See [Security](#security).
> Alerts are **email only** in v1.

## Architecture

```
  ┌─────────────┐   metrics (HTTP + token)    ┌──────────────────────────┐
  │   agent     │  ─────────────────────────▶ │        central           │
  │ (each box)  │                             │  monitoring.omrani…com    │
  │ collectors: │                             │  Node http (:16000)       │
  │  cpu/mem    │                             │  • /api/ingest  (token)  │
  │  disk       │                             │  • alert engine (state)  │
  │  pm2        │                             │  • email notifier        │
  │  nginx+ssl  │                             │  • React SPA (dist/)     │
  │  specs      │                             │  • login gate            │
  └─────────────┘                             └──────────────────────────┘
```

- **agent** (`agent/`) — a thin Node process that samples the box every N
  seconds and POSTs a snapshot to central with a shared token. Runs under pm2
  on each monitored server.
- **central** (`src/`) — React client (`src/client/`) + a zero-dep Node `http`
  server (`src/server.js`) that serves the built SPA, exposes the API, runs the
  alert engine, and gates the UI behind a password session.

## The alert loop (the actual product)

For every incoming snapshot, each enabled rule is evaluated:

1. value crosses its threshold → `OK → FIRING`, send **one** email.
2. while `FIRING`, re-send every `remindMinutes`.
3. value drops back under threshold → `FIRING → OK`, send a **recovered** email.

State lives in `src/server/alerts.js`.

## Quick start (local dev)

```bash
npm install
cp config.example.json config.json     # set password, sessionSecret, ingestToken, SMTP

# Terminal 1 — backend API + alert engine on :16000
npm start

# Terminal 2 — Vite dev client on :16001 (proxies /api to :16000)
npm run dev

# Terminal 3 — an agent reporting into central
npm run agent
```

Dev UI: http://127.0.0.1:16001  ·  Production build is served by `npm start`
on :16000 (after `npm run build`).

## Production (same shape as it.omranisystems.com)

```bash
npm run build          # writes dist/
pm2 start npm --name monitoring -- start   # serves dist/ + API on :16000
```

Then point nginx `monitoring.omranisystems.com` at `127.0.0.1:16000` with TLS.
On each monitored box, run the agent under pm2 with `CENTRAL_URL` and the
shared `INGEST_TOKEN`. Config can come from `config.json` or the environment /
`.env` (`PORT`, `HOST`, `CENTRAL_PASSWORD`, `SESSION_SECRET`, `INGEST_TOKEN`).

## Security

This app sees your processes, nginx routing, and IPs — treat it as sensitive.

- **Login gate on the whole UI** (`src/server/auth.js`): HMAC-signed session
  cookie, password from config/env. The API returns 401 without it.
- **Agent → central is token-authed** with a shared `INGEST_TOKEN`.
- **Read-only by default.** v1 exposes no state-changing actions on boxes.
- **Before going public:** terminate TLS at nginx, add an IP allowlist, and
  ideally keep the whole thing behind a VPN / Tailscale.
- **No raw terminal.** A password-gated web shell on a public URL is a
  fleet-wide RCE backdoor. The planned path is *scoped action buttons*
  (restart a pm2 app, reload nginx, tail a log) as named, audited operations.

## Roadmap

- **Core (this draft):** agent→central pipeline · CPU/RAM/disk threshold
  alerts with firing/recover state · email receiver + test-send · read-only
  dashboard · login gate.
- **Fast-follow:** scoped action buttons · uptime 200-check · live start/stop
  stream · log tail · persist history to SQLite.
- **Later:** multi-server fleet view · per-rule routing · true terminal behind
  VPN (only if still wanted).

## Styling

Design tokens live at the top of `src/client/styles.css`, inherited from
`it.omranisystems.com` (navy palette, Sora / Inter / JetBrains Mono, petrol +
gold accents, ambient orbs) so the two sites read as one family.
