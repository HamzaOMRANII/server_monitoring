# Deploying monitoring.omranisystems.com

Follows the same convention as the other `/projects` apps (pm2 ecosystem +
nginx gate + `deploy.sh`). The app listens only on `127.0.0.1:16000`; nginx
terminates TLS and sits in front.

## One-time setup

1. **Place the repo at the conventional path** so `deploy.sh` works:
   ```bash
   # the repo must live at /projects/server_monitoring
   ```

2. **Create `config.json`** on the box (gitignored — never committed, survives
   `git reset --hard`). It already exists on the central host from first setup;
   it holds the dashboard password, sessionSecret, ingestToken, and the SMTP
   (Gmail, reused from chat_backend). On a fresh box:
   ```bash
   cp config.example.json config.json   # then edit the secrets
   ```

3. **Add the pm2 entries** from `ecosystem.snippet.js` to
   `/projects/ecosystem.config.js`.

4. **Add the nginx block** from `monitoring.omranisystems.com.conf` into
   `/etc/nginx/nginx.conf` (next to the other `*.omranisystems.com` blocks).

5. **Register the gate app** `monitoring` in the omranisystems app
   (e.g. `CODE_MONITORING=...` in `/projects/omranisystems/.env` + its app
   registry), OR drop the gate from the nginx block to use only the app login.

## Apply

```bash
# build + (re)start under pm2
cd /projects/server_monitoring
npm ci && npm run build
pm2 reload /projects/ecosystem.config.js --only monitoring --update-env
pm2 reload /projects/ecosystem.config.js --only monitoring-agent --update-env
pm2 save

# nginx
nginx -t && systemctl reload nginx
```

Or, once committed to a remote and the ecosystem entries are in place:
```bash
/projects/deploy.sh server_monitoring monitoring        # central
# monitoring-agent reloads with the ecosystem; or add a second call
```

## Monitoring other boxes

On each additional server, run only the agent (no central, no nginx):
```bash
INGEST_TOKEN=<same-as-central> CENTRAL_URL=https://monitoring.omranisystems.com \
SERVER_NAME=<box-name> npm run agent
```
`/api/ingest` is intentionally ungated, so agents reach it with just the
Bearer token.

## Verify

```bash
curl -s https://monitoring.omranisystems.com/healthz        # -> ok
# UI: open https://monitoring.omranisystems.com -> gate -> app login
```
