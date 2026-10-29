'use strict';

// API handler for the single-server monitoring app. Pure function of
// (req, res, ctx); the main server routes /api/* here. Login/logout are
// public; everything else requires a UI session. There is no remote ingest
// and no fleet — the app samples its own box in-process (see sampler.js).

const store = require('./store');
const alerts = require('./alerts');
const settings = require('./settings');
const notifier = require('./notifier');
const actions = require('./actions');
const logs = require('./logs');
const uptime = require('./uptime');
const history = require('./history');
const metrics = require('./metrics');
const { sendJson, readJsonBody } = require('./http-util');

async function handle(req, res, pathname, ctx) {
  const { auth } = ctx;
  const method = req.method;

  // --- public: login / logout ---
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!auth.hasPassword) return sendJson(res, 500, { error: 'no password configured' });
    if (!auth.checkPassword(body && body.password)) return sendJson(res, 401, { error: 'invalid password' });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieFor() });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  // --- everything below requires a session ---
  if (!auth.isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });

  // Latest snapshot for this server + any firing alerts.
  if (pathname === '/api/metrics' && method === 'GET') {
    return sendJson(res, 200, { server: store.current(), alerts: alerts.activeAlerts() });
  }

  // Time series for the charts. ?range=1h (10 s samples from memory) or
  // 6h / 24h / 7d / 30d / 90d (minute rows from SQLite, ~300 buckets with peaks).
  if (pathname === '/api/history' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const range = url.searchParams.get('range') || '1h';
    if (range !== '1h') {
      if (!metrics.RANGES[range]) return sendJson(res, 400, { error: 'unknown range' });
      return sendJson(res, 200, metrics.series(range));
    }
    const rows = store.since(60 * 60 * 1000);
    return sendJson(res, 200, {
      range, from: Date.now() - 3600e3, to: Date.now(), stepMs: 10000,
      points: rows.map((s) => ({ ts: s.ts, cpu: round(s.cpuPercent), mem: round(s.memPercent), disk: round(mainDiskPercent(s)), load1: s.specs?.loadavg?.[0] ?? null })),
    });
  }

  // --- Alert history ---
  if (pathname === '/api/alerts/history' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const days = Number(url.searchParams.get('days'));
    return sendJson(res, 200, history.query({
      days: [1, 7, 30, 90, 0].includes(days) ? days : 7,
      rule: (url.searchParams.get('rule') || '').slice(0, 40),
      q: (url.searchParams.get('q') || '').slice(0, 100),
    }));
  }

  // --- Uptime + certificates ---
  if (pathname === '/api/uptime' && method === 'GET') {
    return sendJson(res, 200, uptime.view(settings.get()));
  }
  if (pathname === '/api/uptime/summary' && method === 'GET') {
    return sendJson(res, 200, uptime.summary(settings.get()));
  }
  if (pathname === '/api/uptime/check' && method === 'POST') {
    await uptime.runOnce(settings.get());
    return sendJson(res, 200, uptime.view(settings.get()));
  }
  // Ignore / watch one target: { name, ignored }
  if (pathname === '/api/uptime/ignore' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    const name = String((body && body.name) || '').trim().toLowerCase();
    if (!name || name.length > 300) return sendJson(res, 400, { error: 'name required' });
    const cur = new Set((settings.get().uptime && settings.get().uptime.ignore) || []);
    if (body.ignored) cur.add(name); else cur.delete(name);
    settings.update({ uptime: { ignore: [...cur] } });
    await uptime.runOnce(settings.get());
    return sendJson(res, 200, uptime.view(settings.get()));
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, settings.publicView());
  }
  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJsonBody(req).catch(() => null);
    settings.update(body || {});
    return sendJson(res, 200, settings.publicView());
  }
  if (pathname === '/api/settings/test-email' && method === 'POST') {
    const result = await notifier.sendTest(settings.get().receivers);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // --- Logs (read-only) ---
  if (pathname === '/api/logs/sources' && method === 'GET') {
    return sendJson(res, 200, { sources: logs.publicSources(await logs.sources()) });
  }
  if (pathname === '/api/logs/tail' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const result = await logs.tail(url.searchParams.get('source'),
      url.searchParams.get('lines'), url.searchParams.get('q') || '');
    return sendJson(res, result.error ? 404 : 200, result);
  }

  // --- Console: scoped, allow-listed actions (re-auth with password) ---
  // "Fill the password before starting": unlock verifies the password; the
  // client then sends it with each run, and the server re-verifies every time.
  if (pathname === '/api/console/unlock' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!auth.checkPassword(body && body.password)) return sendJson(res, 401, { error: 'invalid password' });
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/actions' && method === 'GET') {
    return sendJson(res, 200, { actions: actions.list() });
  }
  if (pathname === '/api/actions/run' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!auth.checkPassword(body && body.password)) return sendJson(res, 401, { error: 'password required' });
    const result = await actions.execute(body.id, body.arg);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  return sendJson(res, 404, { error: 'not found' });
}

function round(n) {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : null;
}

// Usage % of the largest real mount (the "main" disk), for the history chart.
function mainDiskPercent(s) {
  const disks = (s && s.disks) || [];
  if (!disks.length) return null;
  const main = disks.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a), disks[0]);
  return main.usedPercent;
}

module.exports = { handle };
