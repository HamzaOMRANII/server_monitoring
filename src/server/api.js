'use strict';

// API handler for the central app. Pure functions of (req, res, ctx); the main
// server routes /api/* here. The login/logout and agent-ingest endpoints are
// public (ingest is token-authed); everything else requires a UI session.

const store = require('./store');
const alerts = require('./alerts');
const settings = require('./settings');
const notifier = require('./notifier');
const { sendJson, readJsonBody } = require('./http-util');

// returns true if it handled the request
async function handle(req, res, pathname, ctx) {
  const { auth, cfg } = ctx;
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

  // --- agent ingest: token-authed (machines, not UI session) ---
  if (pathname === '/api/ingest' && method === 'POST') {
    const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!cfg.central.ingestToken || supplied !== cfg.central.ingestToken) {
      return sendJson(res, 401, { error: 'bad ingest token' });
    }
    const snapshot = await readJsonBody(req).catch(() => null);
    if (!snapshot || !snapshot.server) return sendJson(res, 400, { error: 'missing server name' });
    snapshot.ts = Date.now();
    store.record(snapshot);
    try { await alerts.process(snapshot, settings.get()); }
    catch (err) { console.error('[api] alert processing failed:', err.message); }
    return sendJson(res, 200, { ok: true });
  }

  // --- everything below requires a session ---
  if (!auth.isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (pathname === '/api/overview' && method === 'GET') {
    return sendJson(res, 200, { servers: store.allLatest(), alerts: alerts.activeAlerts() });
  }

  const serverMatch = pathname.match(/^\/api\/server\/([^/]+)$/);
  if (serverMatch && method === 'GET') {
    const latest = store.latest(decodeURIComponent(serverMatch[1]));
    return latest ? sendJson(res, 200, latest) : sendJson(res, 404, { error: 'unknown server' });
  }

  const histMatch = pathname.match(/^\/api\/server\/([^/]+)\/history$/);
  if (histMatch && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const minutes = Math.min(Number(url.searchParams.get('minutes')) || 60, 180);
    const rows = store.history(decodeURIComponent(histMatch[1]), minutes * 60 * 1000)
      .map((s) => ({ ts: s.ts, cpuPercent: s.cpuPercent, memPercent: s.memPercent }));
    return sendJson(res, 200, rows);
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

  return sendJson(res, 404, { error: 'not found' });
}

module.exports = { handle };
