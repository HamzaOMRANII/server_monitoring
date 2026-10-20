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

  // Time series for the charts. ?minutes=60 -> downsampled cpu/mem/disk points.
  if (pathname === '/api/history' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const minutes = Math.min(Number(url.searchParams.get('minutes')) || 60, 240);
    const rows = store.since(minutes * 60 * 1000);
    const series = rows.map((s) => ({
      ts: s.ts,
      cpu: round(s.cpuPercent),
      mem: round(s.memPercent),
      disk: round(mainDiskPercent(s)),
    }));
    return sendJson(res, 200, series);
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
