'use strict';

// Minimal password-session login gate. No external session store or deps:
// on successful login we hand out an httpOnly cookie holding an HMAC-signed,
// time-limited token. Every protected request re-verifies the signature.
//
// This is intentionally simple for v1. Before exposing publicly, also put an
// IP allowlist / VPN in front (see README "Security").

const crypto = require('crypto');

const COOKIE = 'sm_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  // constant-time compare
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0])
  );
}

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still spend the compare to avoid trivial length timing leak
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function create(cfg) {
  const secret = cfg.central.sessionSecret || 'insecure-dev-secret';
  const password = cfg.central.password || '';

  function issueCookie(res) {
    const token = sign({ ok: true, exp: Date.now() + MAX_AGE_MS }, secret);
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}`);
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  function isAuthed(req) {
    const cookies = parseCookies(req);
    return !!verify(cookies[COOKIE], secret);
  }

  // Gate middleware for protected routes.
  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    // req.path is relative to the mount point inside a router, so check the
    // full original URL to reliably detect API calls (→ 401 JSON, not a redirect).
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.redirect('/login.html');
  }

  function login(req, res) {
    const supplied = (req.body && req.body.password) || '';
    if (!password) {
      return res.status(500).json({ error: 'no password configured' });
    }
    if (!constantTimeEquals(supplied, password)) {
      return res.status(401).json({ error: 'invalid password' });
    }
    issueCookie(res);
    return res.json({ ok: true });
  }

  function logout(req, res) {
    clearCookie(res);
    return res.json({ ok: true });
  }

  return { requireAuth, login, logout, isAuthed };
}

module.exports = { create };
