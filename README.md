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
- **History charts** — CPU, memory and main disk for the last hour (10 s
  samples, memory) or 6 h / 24 h / 7 d / 30 d (minute rows in SQLite, ~300
  points, dashed line = peak), with a Live/Paused switch. Hover crosshair +
  tooltip. Kept 90 days; pm2 per-app minutes and uptime checks 30 days.
- **Storage** — a ring gauge for the main mount plus a used/total bar per
  mount, coloured by usage level.
- **Apps (pm2)** — status, CPU, memory, uptime, restarts and the worst
  advice per app. CPU/memory are measured from `/proc` over each app's whole
  process tree (pm2's own monit reads 0 for `npm start` apps).
- **Per-app page (`/apps/<name>`)** — CPU/memory over 1 h → 30 d with restarts
  marked, ports its process tree listens on and the nginx sites routed to it,
  folder/script/PORT, last error and output log lines (falls back to the
  newest pm2-logrotate file), and advice with copyable commands: not online,
  code folder missing, port held by an orphan process, nothing listening on
  PORT, crash loop (restarts in the last hour + last error line), steady
  memory growth (least-squares trend since the last restart), high memory/CPU,
  recent error-log writes, old restart counter.
- **nginx** — the routing map (server_name → upstream) across `nginx.conf`,
  `conf.d/` and `sites-enabled/`, with TLS expiry (per-site cert or the one set
  at `http{}` level).
- **Uptime (`/uptime`)** — every HTTPS site in the nginx config, checked every
  minute three ways: the public URL (like a visitor; gate/login redirects count
  as up), the app's upstream directly (catches a crashed app hidden behind an
  access gate), and certificates (origin via 127.0.0.1:443 + SNI, public edge,
  plus extra `host:port` TLS endpoints such as coturn). 24 h uptime, last 60
  checks, Ignore/Watch per site, "Check now". Email alerts: **Site down** after
  N failed checks, **Certificate expiry** at ≤ N days. Options in Settings
  (extra URLs, TLS endpoints, ignored hosts, interval, timeout).
- **Alert history (`/alerts`)** — every alert episode (fired → recovered or
  cleared) stored in SQLite (`data/monitoring.db`, Node's built-in
  `node:sqlite`, kept 180 days): timeline per rule/target, period filter
  (24 h → all), rule filter, search, totals (alerts, site downtime, mean time
  to recover, emails sent), most-affected list. Alerts still firing at a
  restart are resumed without a second email.
- **Security (`/security`, read-only)** — failed SSH logins per hour (7 d
  chart) and top attacking addresses with the user names they tried, every
  successful SSH login (new addresses flagged), listening ports classified
  against iptables/ip6tables (this server only / Cloudflare only / internet),
  `sshd -T` settings, fail2ban, pending apt updates, reboot-required, and
  findings with copyable fix commands. auth.log is read incrementally
  (position kept across restarts and rotation; first run backfills 7 days).
  Alerts: new port open to the internet (first run = known baseline; "mark as
  known" on the page), SSH brute force (failed logins/hour), optional email on
  every successful SSH login.
- **Email digest** — daily (last 24 h) and/or weekly (last 7 days) HTML +
  text email at a set hour and time zone (default 08:00 Asia/Ho_Chi_Minh,
  weekly on Monday replacing that day's daily): what needs attention, CPU/RAM
  averages and peaks, disk change and days-to-full, uptime per site, alerts,
  certificates, apps (crashes vs manual restarts, advice), security summary.
  Preview and "Send daily now" in Settings; sent periods are remembered, so a
  restart never sends twice.
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
