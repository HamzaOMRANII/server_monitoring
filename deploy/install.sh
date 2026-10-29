#!/usr/bin/env bash
#
# install.sh — deploy the single-server monitor on THIS machine.
#
# The app monitors the box it runs on and shows only that box. Run this once
# per server you want to watch. It is self-contained: it does not depend on any
# shared pm2 ecosystem file, so it works on a brand-new server.
#
# Usage:
#   ./deploy/install.sh [--name NAME] [--port PORT] [--domain DOMAIN] [--no-nginx]
#
#   --name NAME      pm2 process + display name   (default: monitoring)
#   --port PORT      local port the app binds      (default: 16000)
#   --domain DOMAIN  public hostname for nginx     (default: none -> skip nginx)
#   --no-nginx       never touch nginx even if --domain is given
#
# Examples:
#   ./deploy/install.sh                                   # localhost only, no nginx
#   ./deploy/install.sh --domain monitoring.example.com   # + nginx on :80 (then certbot)
#
set -euo pipefail

NAME="monitoring"
PORT="16000"
DOMAIN=""
DO_NGINX="auto"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --no-nginx) DO_NGINX="no"; shift;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
echo "==> repo: $REPO   name: $NAME   port: $PORT   domain: ${DOMAIN:-<none>}"

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null || { echo "node is required (>= 22.5)"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null || { echo "node >= 22.5 is required (built-in node:sqlite for the alert history)"; exit 1; }
command -v npm  >/dev/null || { echo "npm is required"; exit 1; }
command -v pm2  >/dev/null || { echo "pm2 is required (npm i -g pm2)"; exit 1; }

# --- build -------------------------------------------------------------------
echo "==> installing dependencies"
npm ci
echo "==> building client"
npm run build

# --- config.json (create with generated secrets if absent) -------------------
if [ ! -f config.json ]; then
  echo "==> creating config.json with generated secrets"
  gen() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; fi; }
  DASH_PW="mon-$(node -e "console.log(require('crypto').randomBytes(6).toString('base64url'))")"
  SESSION="$(gen 32)"
  node -e '
    const fs=require("fs");
    const c=JSON.parse(fs.readFileSync("config.example.json"));
    c.central.password=process.env.DASH_PW;
    c.central.sessionSecret=process.env.SESSION;
    c.central.port=Number(process.env.PORT);
    c.monitor.serverName=process.env.NAME;
    fs.writeFileSync("config.json", JSON.stringify(c,null,2));
  ' DASH_PW="$DASH_PW" SESSION="$SESSION" PORT="$PORT" NAME="$NAME"
  echo "    ----------------------------------------------------------------"
  echo "    DASHBOARD PASSWORD: $DASH_PW"
  echo "    (saved in config.json -> central.password; change it any time)"
  echo "    Set SMTP under receivers.email in config.json to enable alerts."
  echo "    ----------------------------------------------------------------"
else
  echo "==> config.json already exists — leaving it untouched"
fi

# --- pm2 ---------------------------------------------------------------------
echo "==> starting under pm2 as \"$NAME\""
export PORT HOST="127.0.0.1"
if pm2 describe "$NAME" >/dev/null 2>&1; then
  pm2 restart "$NAME" --update-env
else
  pm2 start npm --name "$NAME" --update-env -- start
fi
pm2 save

# --- nginx (optional) --------------------------------------------------------
if [ -n "$DOMAIN" ] && [ "$DO_NGINX" != "no" ]; then
  if command -v nginx >/dev/null && [ -d /etc/nginx/conf.d ]; then
    echo "==> writing nginx config for $DOMAIN"
    sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" \
      "$REPO/deploy/nginx.template.conf" > "/etc/nginx/conf.d/$NAME.conf"
    if nginx -t; then
      systemctl reload nginx || nginx -s reload
      echo "    nginx reloaded. For TLS run:  certbot --nginx -d $DOMAIN"
    else
      echo "    !! nginx -t failed; left /etc/nginx/conf.d/$NAME.conf in place for review"
    fi
  else
    echo "==> nginx not found or no conf.d — skipping (see deploy/INSTALL.md)"
  fi
fi

echo "==> done. Local health check:"
sleep 2
curl -fsS "http://127.0.0.1:$PORT/healthz" && echo "  (ok)" || echo "  (not responding yet — check: pm2 logs $NAME)"
echo "==> open: ${DOMAIN:+https://$DOMAIN}  (or http://127.0.0.1:$PORT via SSH tunnel)"
