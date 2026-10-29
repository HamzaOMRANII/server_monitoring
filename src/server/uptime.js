'use strict';

// Uptime + certificate checks (M1).
//
// Every `intervalSeconds` each target is checked three ways:
//   public — GET https://host/ through DNS/Cloudflare, like a visitor. No redirect
//            following: the access gate answers 302 for a healthy site.
//   app    — GET the nginx upstream (http://127.0.0.1:port/) directly. The gate
//            answers even when the app behind it is dead, so this is what
//            catches a crashed pm2 app.
//   certs  — days left on the certificate nginx serves for the host (origin,
//            via 127.0.0.1:443 + SNI), on the public edge, and on extra TLS
//            endpoints (e.g. coturn on turn.example.com:5349).
//
// Targets come from the nginx map (443 blocks, no wildcards) plus extra URLs /
// TLS endpoints from settings; hosts in `ignore` are skipped. History is kept in
// memory (24 h at one check a minute). Alerts reuse the alert engine:
//   siteDown  — fires after N consecutive failed checks (public or app)
//   sslExpiry — fires when a certificate has <= N days left

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const alerts = require('./alerts');
const store = require('./store');

const DEFAULTS = {
  uptime: { intervalSeconds: 60, timeoutSeconds: 10, ignore: [], extraUrls: [], tlsEndpoints: [] },
  siteDown: { enabled: true, failures: 2, remindMinutes: 30 },
  sslExpiry: { enabled: true, days: 14, remindMinutes: 1440 },
};
const HISTORY_MAX = 1440;
const DAY = 24 * 60 * 60 * 1000;

const results = new Map(); // id -> { ...target, public, app, certs, history[], failures }
let lastRun = 0;
let running = null;
let timer = null;

function config(settings) {
  const rules = settings.alertRules || {};
  return {
    uptime: { ...DEFAULTS.uptime, ...(settings.uptime || {}) },
    siteDown: { ...DEFAULTS.siteDown, ...(rules.siteDown || {}) },
    sslExpiry: { ...DEFAULTS.sslExpiry, ...(rules.sslExpiry || {}) },
  };
}

function targets(cfg) {
  const ignore = new Set((cfg.uptime.ignore || []).map((h) => String(h).toLowerCase()));
  const out = [];
  const sites = store.current()?.nginx?.sites || [];
  for (const s of sites) {
    if (!s.https) continue;
    const upstream = (s.upstreams || []).find((u) => /^https?:\/\//.test(u)) || null;
    for (const host of s.serverNames) {
      if (host.includes('*') || !host.includes('.')) continue;
      out.push({ id: `site:${host}`, kind: 'site', host, url: `https://${host}/`, upstream, origin: true, ignored: ignore.has(host) });
    }
  }
  for (const raw of cfg.uptime.extraUrls || []) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    out.push({ id: `url:${u.href}`, kind: 'url', host: u.hostname, url: u.href, upstream: null, origin: false, ignored: ignore.has(u.href.toLowerCase()) });
  }
  for (const raw of cfg.uptime.tlsEndpoints || []) {
    const m = String(raw).trim().match(/^([a-z0-9.-]+):(\d{1,5})$/i);
    if (!m) continue;
    const id = `tls:${m[1]}:${m[2]}`;
    out.push({ id, kind: 'tls', host: m[1], port: Number(m[2]), url: null, upstream: null, origin: false, ignored: ignore.has(`${m[1]}:${m[2]}`.toLowerCase()) });
  }
  // the same host can appear in two server blocks: keep the first
  const seen = new Set();
  return out.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

// One HTTP(S) request, headers only. Resolves { status, ms, location, cert } or { error, ms }.
function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let u;
    try { u = new URL(url); } catch { return resolve({ error: 'bad URL', ms: 0 }); }
    const mod = u.protocol === 'https:' ? https : http;
    let cert = null;
    const req = mod.request(u, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'omrani-monitoring/uptime', Accept: 'text/html,*/*' },
      agent: false,
    }, (res) => {
      if (res.socket && res.socket.getPeerCertificate) cert = certInfo(res.socket.getPeerCertificate());
      resolve({ status: res.statusCode, ms: Date.now() - started, location: res.headers.location || null, cert });
      res.destroy();
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', (err) => resolve({ error: shortError(err), ms: Date.now() - started }));
    req.end();
  });
}

// TLS handshake only, to read the certificate. `connectHost` lets us ask the local
// nginx (127.0.0.1) for the certificate of `servername`.
function tlsCert(connectHost, port, servername, timeoutMs) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: connectHost, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const info = certInfo(sock.getPeerCertificate());
      sock.end();
      resolve(info || { error: 'no certificate' });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'timeout' }); });
    sock.on('error', (err) => resolve({ error: shortError(err) }));
  });
}

function certInfo(c) {
  if (!c || !c.valid_to) return null;
  const end = new Date(c.valid_to).getTime();
  if (Number.isNaN(end)) return null;
  return {
    validTo: new Date(end).toISOString(),
    days: Math.floor((end - Date.now()) / DAY),
    issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
    subject: (c.subject && c.subject.CN) || null,
  };
}

function shortError(err) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND') return 'DNS: host not found';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code === 'CERT_HAS_EXPIRED') return 'certificate expired';
  return (err && err.message) || String(err);
}

// A visitor-facing answer counts as up: 2xx, redirects (gates, logins) and 401/403.
const publicUp = (r) => !r.error && (r.status < 400 || r.status === 401 || r.status === 403);
// The app answered at all (anything under 500): it is running.
const appUp = (r) => !r.error && r.status < 500;

function describe(r, up) {
  if (r.error) return r.error;
  return `HTTP ${r.status}${!up && r.status >= 500 ? ' (server error)' : ''}`;
}

async function checkTarget(t, cfg) {
  const timeoutMs = Math.max(2, Number(cfg.uptime.timeoutSeconds) || 10) * 1000;
  const out = { public: null, app: null, certs: [] };

  if (t.kind === 'tls') {
    const c = await tlsCert(t.host, t.port, t.host, timeoutMs);
    out.public = c.error ? { up: false, error: c.error } : { up: true, ms: null };
    if (!c.error) out.certs.push({ where: `${t.host}:${t.port}`, ...c });
    return out;
  }

  const [pub, app, origin] = await Promise.all([
    probe(t.url, timeoutMs),
    t.upstream ? probe(t.upstream, timeoutMs) : null,
    t.origin ? tlsCert('127.0.0.1', 443, t.host, timeoutMs) : null,
  ]);
  const pubUp = publicUp(pub);
  out.public = { up: pubUp, status: pub.status ?? null, ms: pub.ms, location: pub.location || null, detail: describe(pub, pubUp) };
  if (pub.error) out.public.error = pub.error;
  if (app) {
    const up = appUp(app);
    out.app = { up, status: app.status ?? null, ms: app.ms, upstream: t.upstream, detail: describe(app, up) };
  }
  if (origin && !origin.error) out.certs.push({ where: 'origin', ...origin });
  if (pub.cert) out.certs.push({ where: 'public', ...pub.cert });
  return out;
}

async function runOnce(settings) {
  if (running) return running;
  running = (async () => {
    const cfg = config(settings);
    const list = targets(cfg);
    const ids = new Set(list.map((t) => t.id));
    for (const [id, old] of results) {
      if (ids.has(id)) continue;
      results.delete(id); // target removed: drop its open alerts silently
      alerts.clear('siteDown', label(old));
      alerts.clear('sslExpiry', label(old));
    }

    await Promise.all(list.map(async (t) => {
      const prev = results.get(t.id) || { history: [], failures: 0 };
      if (t.ignored) {
        results.set(t.id, { ...prev, ...t });
        alerts.clear('siteDown', label(t));
        alerts.clear('sslExpiry', label(t));
        return;
      }
      const r = await checkTarget(t, cfg);
      const up = r.public.up && (!r.app || r.app.up);
      const history = [...prev.history, { ts: Date.now(), up, ms: r.public.ms ?? null }].slice(-HISTORY_MAX);
      const failures = up ? 0 : prev.failures + 1;
      const row = { ...t, ...r, up, failures, history, checkedAt: Date.now() };
      results.set(t.id, row);
      await raise(row, cfg, settings);
    }));
    lastRun = Date.now();
  })().finally(() => { running = null; });
  return running;
}

const label = (t) => (t.kind === 'site' ? t.host : t.kind === 'tls' ? `${t.host}:${t.port}` : t.url);

async function raise(row, cfg, settings) {
  const server = store.current()?.server || 'server';
  const name = label(row);
  if (cfg.siteDown.enabled) {
    const why = !row.public.up ? `public check: ${row.public.detail || row.public.error}`
      : row.app && !row.app.up ? `app ${row.app.upstream}: ${row.app.detail}` : 'answering again';
    await alerts.evaluate({
      server, rule: 'siteDown', target: name,
      value: row.failures, threshold: Math.max(1, Number(cfg.siteDown.failures) || 2),
      remindMinutes: cfg.siteDown.remindMinutes, settings,
      describe: () => `${name} — ${why}`,
      subjects: { fire: `🔴 ${server}: ${name} is DOWN`, still: `🔴 (still) ${server}: ${name} is DOWN`, recover: `🟢 ${server}: ${name} is back up` },
    });
  }
  if (cfg.sslExpiry.enabled && row.certs.length) {
    const worst = row.certs.reduce((a, b) => (b.days < a.days ? b : a));
    const limit = Number(cfg.sslExpiry.days) || 14;
    await alerts.evaluate({
      server, rule: 'sslExpiry', target: name,
      value: -worst.days, threshold: -limit,
      remindMinutes: cfg.sslExpiry.remindMinutes, settings,
      describe: () => `${name}${worst.where === name ? '' : ` (${worst.where})`} certificate ${worst.days < 0 ? 'EXPIRED' : `expires in ${worst.days} day(s)`} — ${worst.validTo.slice(0, 10)}, issuer ${worst.issuer || '?'}`,
      subjects: {
        fire: `🟠 ${server}: certificate for ${name} expires in ${worst.days} day(s)`,
        still: `🟠 (still) ${server}: certificate for ${name} expires in ${worst.days} day(s)`,
        recover: `🟢 ${server}: certificate for ${name} renewed`,
      },
    });
  }
}

function uptimePercent(history, sinceMs) {
  const cutoff = Date.now() - sinceMs;
  const rows = history.filter((h) => h.ts >= cutoff);
  if (!rows.length) return null;
  return Math.round((rows.filter((h) => h.up).length / rows.length) * 1000) / 10;
}

// What the UI gets: latest result per target + 24 h uptime + the last 60 checks.
function view(settings) {
  const cfg = config(settings);
  const rows = [...results.values()].map((r) => ({
    id: r.id, kind: r.kind, host: r.host, port: r.port || null, url: r.url, upstream: r.upstream, ignored: !!r.ignored,
    name: label(r), up: r.ignored ? null : r.up ?? null, failures: r.failures || 0, checkedAt: r.checkedAt || null,
    public: r.public || null, app: r.app || null, certs: r.certs || [],
    uptime24h: uptimePercent(r.history || [], DAY),
    recent: (r.history || []).slice(-60),
  }));
  rows.sort((a, b) => (a.ignored - b.ignored) || ((a.up === false ? 0 : 1) - (b.up === false ? 0 : 1)) || a.name.localeCompare(b.name));
  return { lastRun, intervalSeconds: cfg.uptime.intervalSeconds, sslDays: cfg.sslExpiry.days, failuresToAlert: cfg.siteDown.failures, targets: rows };
}

// Short summary for the dashboard tile.
function summary(settings) {
  const v = view(settings);
  const active = v.targets.filter((t) => !t.ignored && t.up !== null);
  const certs = active.flatMap((t) => t.certs.map((c) => ({ ...c, name: t.name })));
  const soonest = certs.length ? certs.reduce((a, b) => (b.days < a.days ? b : a)) : null;
  return { total: active.length, up: active.filter((t) => t.up).length, down: active.filter((t) => !t.up).map((t) => t.name), soonestCert: soonest };
}

function start(getSettings) {
  const tick = async () => {
    try { await runOnce(getSettings()); } catch (err) { console.error('[uptime] run failed:', err.message); }
    const every = Math.max(30, Number(config(getSettings()).uptime.intervalSeconds) || 60) * 1000;
    timer = setTimeout(tick, every);
    timer.unref?.();
  };
  // wait for the first nginx snapshot so the targets exist
  timer = setTimeout(tick, 5000);
  timer.unref?.();
}

module.exports = { start, runOnce, view, summary, config, DEFAULTS, publicUp, appUp };
