# Installing the monitor on a new server

This is a **single-server** app: it monitors the box it runs on and shows only
that box. To watch another server, install a separate instance on that server.
There is no central/fleet view by design.

## TL;DR (automated)

On the server you want to watch:

```bash
git clone git@github.com:HamzaOMRANII/server_monitoring.git /opt/monitoring
cd /opt/monitoring

# localhost only (reach it via SSH tunnel):
./deploy/install.sh

# or publish on a domain (writes nginx on :80, then add TLS with certbot):
./deploy/install.sh --domain monitoring.myserver.com
certbot --nginx -d monitoring.myserver.com
```

`install.sh` is self-contained — it does **not** need any shared pm2 ecosystem
file, so it works on a brand-new box. It will:

1. `npm ci` and `npm run build`
2. create `config.json` with a generated dashboard password + session secret
   (printed once — copy it) if one doesn't exist
3. start the app under pm2 (`pm2 start npm --name monitoring -- start`) and
   `pm2 save`
4. if `--domain` is given and nginx is present, write
   `/etc/nginx/conf.d/<name>.conf` from `nginx.template.conf`, test, and reload

Options: `--name NAME` (default `monitoring`), `--port PORT` (default `16000`),
`--domain DOMAIN`, `--no-nginx`.

## What to configure after install

Edit `config.json` (gitignored, never committed):

- **`central.password`** — dashboard login. Change the generated one.
- **`receivers.email`** — to get alert emails, enable it and fill SMTP. For
  Gmail use an **App Password** (16 chars), host `smtp.gmail.com`, port `465`,
  `secure: true`. A regular account password will be rejected.
- **`monitor.serverName`** — display name (defaults to the hostname).
- **`alertRules`** — CPU / RAM / disk thresholds and reminder intervals.

Then `pm2 restart <name>`. Changes to thresholds/receivers can also be made
live in the **Settings** page without a restart.

## Manual steps (if you don't use install.sh)

```bash
cd /opt/monitoring
npm ci && npm run build
cp config.example.json config.json         # edit secrets + SMTP
PORT=16000 HOST=127.0.0.1 pm2 start npm --name monitoring -- start
pm2 save
```

Nginx (publish on a domain):

```bash
sed -e 's/__DOMAIN__/monitoring.myserver.com/g' -e 's/__PORT__/16000/g' \
  deploy/nginx.template.conf > /etc/nginx/conf.d/monitoring.conf
nginx -t && systemctl reload nginx
certbot --nginx -d monitoring.myserver.com     # TLS
```

If the box already terminates TLS (e.g. behind Cloudflare with a wildcard cert
set at the `http{}` level — as on the omranisystems host), change
`listen 80;` to `listen 443 ssl http2;` in the generated conf and skip certbot.

## Keeping it running

`pm2 save` persists the process list; `pm2 startup` (once per box) makes pm2
restart everything on reboot.

## Updating

```bash
cd /opt/monitoring
git pull
npm ci && npm run build
pm2 restart monitoring
```

## Ports

Default `16000`. Pick a free one with `--port` if that's taken. The app binds
`127.0.0.1` only — it is never directly exposed; nginx is the public door.
