# server_monitoring

Alert-first, **single-server** monitoring — one self-contained instance per box
that watches the machine it runs on and shows only that machine. Install it on
any server you want to watch. No central/fleet view by design.

Built on the **same stack as it.omranisystems.com**: a React 19 + Vite 8
client, served in production by a zero-dependency Node `http` server behind
nginx. The only runtime dependency is `nodemailer` (email alerts).

The reference deployment is **monitoring.omranisystems.com** (port 16000).

## What it shows

- **Stat tiles** — CPU, memory, main-disk usage, uptime, pm2 apps online,
  nginx sites.
- **History charts** — CPU and memory over the last hour (inline-SVG area
  charts with a hover crosshair + tooltip).
- **Storage** — a ring gauge for the main mount plus a used/total bar per
  mount, coloured by usage level.
- **Apps (pm2)** — status, CPU, memory, uptime, restarts per process.
- **nginx** — the routing map (server_name → upstream) across `nginx.conf`,
  `conf.d/` and `sites-enabled/`, with TLS expiry where a per-site cert exists.
- **Specs** — hostname, platform, CPU, memory, IPs, load average.

## How it works

```
         ┌──────────────────────────────────────────────┐
         │  monitor (one per box)   Node http :16000      │
         │                                                │
         │  sampler ── collectors (cpu/mem/disk/pm2/      │
         │     every N s     nginx/specs) ── store        │
         │                              │                 │
         │                        alert engine ── email   │
         │                                                │
         │  React SPA (dist/) + /api + login gate         │
         └──────────────────────────────────────────────┘
```

An in-process **sampler** runs the collectors on a timer, records each snapshot
to an in-memory ring buffer, and feeds the **alert engine** (threshold →
`FIRING` → reminder → recovered, by email). The React dashboard reads
`/api/metrics` and `/api/history`. Everything is gated behind a password login.

## Quick start (local dev)

```bash
npm install
cp config.example.json config.json     # set password, sessionSecret, SMTP

npm start      # app + built SPA on :16000 (also runs the sampler)
npm run dev    # Vite dev client on :16001 (proxies /api) — for development
```

## Deploy on any server

See **[deploy/INSTALL.md](deploy/INSTALL.md)**. In short, on the target box:

```bash
git clone git@github.com:HamzaOMRANII/server_monitoring.git /opt/monitoring
cd /opt/monitoring
./deploy/install.sh --domain monitoring.myserver.com   # build + config + pm2 + nginx
certbot --nginx -d monitoring.myserver.com             # TLS (standalone boxes)
```

`install.sh` is self-contained (no shared ecosystem file needed), generates
secrets, starts pm2, and writes the nginx proxy. `deploy/nginx.template.conf`
is the proxy template.

## Configuration (`config.json`, gitignored)

- `central` — `host`, `port`, `password` (dashboard login), `sessionSecret`.
- `monitor` — `serverName` (display; defaults to hostname), `sampleSeconds`,
  `nginxSitesDir`.
- `alertRules` — CPU / RAM / disk thresholds + reminder minutes.
- `receivers.email` — SMTP (Gmail: App Password, `smtp.gmail.com:465`, TLS).

Thresholds and the email receiver can also be edited live in the **Settings**
page (no restart).

## Security

- **Login gate** on the whole UI (HMAC session cookie); API returns 401 without
  it. `/healthz` is the only open path.
- App binds `127.0.0.1` only — nginx terminates TLS and is the public door.
- Before exposing publicly: TLS, and ideally an IP allowlist / VPN.
- **No raw terminal.** A password-gated web shell is a remote-code-execution
  backdoor; scoped action buttons (restart a pm2 app, reload nginx) are the
  planned path instead.

## Styling

Design tokens at the top of `src/client/styles.css` are inherited from
`it.omranisystems.com` (navy palette, Sora / Inter / JetBrains Mono, petrol +
gold accents, ambient orbs) so the two sites read as one family.
