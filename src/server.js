/**
 * Central app server for monitoring.omranisystems.com.
 *
 * Same shape as it.omranisystems.com/src/server.js — a zero-dependency Node
 * http server that serves the Vite build (./dist) behind nginx — but extended
 * with:
 *   - an in-process sampler that monitors the single box this runs on
 *   - /api/*     the monitoring API (metrics, history, settings, auth)
 *   - a login gate on the SPA: unauthenticated page loads are redirected to
 *     /login, and the API returns 401 (the client redirects).
 *   - /healthz   for pm2 / uptime checks
 *
 * Single-server by design: one instance per box, each showing only itself.
 * The only runtime dependency is nodemailer (email alerts). Env: PORT
 * (default 16000), HOST (default 127.0.0.1) — from the environment or .env.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { load, ROOT } = require('./server/config');
const authFactory = require('./server/auth');
const settings = require('./server/settings');
const sampler = require('./server/sampler');
const uptime = require('./server/uptime');
const api = require('./server/api');
const { sendText } = require('./server/http-util');

const cfg = load();
settings.seedFrom(cfg);
const auth = authFactory.create(cfg);
const serverName = sampler.start(cfg); // begin sampling this box immediately
uptime.start(settings.get); // site uptime + certificate checks

const PORT = cfg.central.port || 16000;
const HOST = cfg.central.host || '127.0.0.1';
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Routes the SPA can render. Extension-less requests to these resolve to
// index.html; /login is allowed without a session, the rest require one.
const APP_ROUTES = new Set(['/', '/settings', '/login']);

function serveFile(req, res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(DIST, file).split(path.sep).join('/');
  const hashed = rel.startsWith('assets/');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(status, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': st.size,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (pathname === '/healthz') {
    return sendText(res, 200, 'ok', { 'Cache-Control': 'no-store' });
  }

  // API
  if (pathname.startsWith('/api/')) {
    try {
      await api.handle(req, res, pathname, { auth, cfg });
    } catch (err) {
      console.error('[central] api error:', err.message);
      if (!res.headersSent) sendText(res, 500, 'Internal error');
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  // Static asset or SPA route
  const target = path.normalize(path.join(DIST, pathname));
  if (target !== DIST && !target.startsWith(DIST + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  const isRoute = pathname.endsWith('/') || !path.extname(pathname);
  if (isRoute) {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    // Login gate: any app route except /login requires a session.
    if (normalized !== '/login' && !auth.isAuthed(req)) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (!fs.existsSync(INDEX)) {
      return sendText(res, 500, 'Build missing — run "npm run build".');
    }
    return serveFile(req, res, INDEX);
  }

  serveFile(req, res, target);
});

server.listen(PORT, HOST, () => {
  console.log(`[central] monitoring on http://${HOST}:${PORT}`);
  if (!cfg.central.password || cfg.central.password.startsWith('change-me')) {
    console.warn('[central] WARNING: default/empty password — set a real one before exposing.');
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
