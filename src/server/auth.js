'use strict';

// Password-session login gate. No session store or deps: on login we hand out
// an httpOnly cookie holding an HMAC-signed, time-limited token; every
// protected request re-verifies the signature.
//
// This is intentionally simple for v1. Before exposing publicly, also put an
// IP allowlist / VPN in front (see README "Security").

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseCookies } = require('./http-util');
const { ROOT } = require('./config');

// Once the password is changed from Settings it lives here as a salted scrypt
// hash and wins over config.json's plain-text bootstrap password.
const PW_FILE = path.join(ROOT, 'data', 'password.json');

function loadHash() {
  try {
    const j = JSON.parse(fs.readFileSync(PW_FILE, 'utf8'));
    return j && j.salt && j.hash ? j : null;
  } catch { return null; }
}

function scrypt(pw, salt) {
  return crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64).toString('hex');
}

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
  let stored = loadHash();
  // sessions carry the password version: changing the password signs out every other browser
  const version = () => (stored ? stored.changedAt : 0);

  return {
    isAuthed(req) {
      const p = verify(parseCookies(req)[COOKIE], secret);
      return !!p && (p.v || 0) === version();
    },
    cookieFor() {
      const token = sign({ ok: true, v: version(), exp: Date.now() + MAX_AGE_MS }, secret);
      return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_MS / 1000}`;
    },
    clearCookie() {
      return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },
    checkPassword(supplied) {
      if (stored) {
        const a = Buffer.from(scrypt(supplied || '', stored.salt), 'hex');
        const b = Buffer.from(stored.hash, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      return !!password && constantTimeEquals(supplied || '', password);
    },
    // Store a new password (hash only). Returns an error message or null.
    setPassword(next) {
      next = String(next || '');
      if (next.length < 12) return 'the new password needs at least 12 characters';
      if (next.length > 200) return 'the new password is too long';
      const salt = crypto.randomBytes(16).toString('hex');
      const rec = { salt, hash: scrypt(next, salt), changedAt: Date.now() };
      fs.mkdirSync(path.dirname(PW_FILE), { recursive: true });
      fs.writeFileSync(PW_FILE, JSON.stringify(rec), { mode: 0o600 });
      stored = rec;
      return null;
    },
    get hasPassword() { return !!stored || !!password; },
    get passwordChangedAt() { return stored ? stored.changedAt : null; },
  };
}

module.exports = { create };
