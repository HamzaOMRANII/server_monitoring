'use strict';

// Small helpers so the zero-dependency http server reads like a tidy framework
// without pulling one in. Mirrors the style of it.omranisystems.com/src/server.js.

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders });
  res.end(text);
}

// Read and JSON-parse a request body (bounded). Resolves null on empty body,
// rejects on invalid JSON or oversize.
function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0])
  );
}

// Real client address: Cloudflare's header, then nginx's X-Real-IP, then the socket.
function clientIp(req) {
  const h = req.headers;
  return String(h['cf-connecting-ip'] || h['x-real-ip'] || req.socket.remoteAddress || '?').slice(0, 64);
}

// Failed-password limiter: `max` failures per `windowMs` per address, then 429
// until the window passes. In memory (a restart forgets, which is fine).
function failLimiter(max = 8, windowMs = 15 * 60e3) {
  const hits = new Map(); // ip -> [timestamps]
  const recent = (ip) => (hits.get(ip) || []).filter((t) => Date.now() - t < windowMs);
  return {
    blocked: (ip) => recent(ip).length >= max,
    fail: (ip) => { const r = recent(ip); r.push(Date.now()); hits.set(ip, r); if (hits.size > 5000) hits.clear(); },
    reset: (ip) => hits.delete(ip),
    retryAfter: (ip) => { const r = recent(ip); return r.length ? Math.ceil((windowMs - (Date.now() - r[0])) / 1000) : 0; },
  };
}

module.exports = { sendJson, sendText, readJsonBody, parseCookies, clientIp, failLimiter };
