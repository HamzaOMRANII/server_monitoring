'use strict';

// Password-session login gate. No session store or deps: on login we hand out
// an httpOnly cookie holding an HMAC-signed, time-limited token; every
// protected request re-verifies the signature.
//
// This is intentionally simple for v1. Before exposing publicly, also put an
// IP allowlist / VPN in front (see README "Security").

const crypto = require('node:crypto');
const { parseCookies } = require('./http-util');

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

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // spend the compare to avoid length timing leak
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function create(cfg) {
  const secret = cfg.central.sessionSecret || 'insecure-dev-secret';
  const password = cfg.central.password || '';

  return {
    isAuthed(req) {
      return !!verify(parseCookies(req)[COOKIE], secret);
    },
    cookieFor() {
      const token = sign({ ok: true, exp: Date.now() + MAX_AGE_MS }, secret);
      return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}`;
    },
    clearCookie() {
      return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },
    checkPassword(supplied) {
      return !!password && constantTimeEquals(supplied || '', password);
    },
    hasPassword: !!password,
  };
}

module.exports = { create };
