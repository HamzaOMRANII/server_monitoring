'use strict';

// Read-only log viewer backend. Exposes a fixed, discovered set of log
// SOURCES — each pm2 process's out/err logs (paths come from `pm2 jlist`) and
// nginx access/error — and tails them from disk. The client only ever sends a
// source *id*; paths are resolved here against the allow-list, never taken from
// the request, so there's no path traversal and no arbitrary file read.

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const NGINX = [
  { id: 'nginx:access', label: 'nginx · access', path: '/var/log/nginx/access.log', kind: 'nginx' },
  { id: 'nginx:error', label: 'nginx · error', path: '/var/log/nginx/error.log', kind: 'nginx' },
];

let cache = { at: 0, list: [] };

function pm2Jlist() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(out.toString())); } catch { resolve([]); }
    });
  });
}

// Discover all sources (cached briefly — pm2 jlist is a little heavy).
async function sources() {
  if (Date.now() - cache.at < 15000 && cache.list.length) return cache.list;
  const list = [];
  for (const p of await pm2Jlist()) {
    const env = p.pm2_env || {};
    if (env.pm_out_log_path) list.push({ id: `pm2:${p.name}:out`, label: `${p.name} · out`, path: env.pm_out_log_path, kind: 'pm2' });
    if (env.pm_err_log_path) list.push({ id: `pm2:${p.name}:err`, label: `${p.name} · err`, path: env.pm_err_log_path, kind: 'pm2' });
  }
  for (const n of NGINX) { try { if (fs.statSync(n.path).isFile()) list.push(n); } catch {} }
  cache = { at: Date.now(), list };
  return list;
}

function publicSources(list) {
  return list.map(({ id, label, kind }) => ({ id, label, kind }));
}

// Tail the last `maxLines` lines of a source, optionally filtered by `q`.
// Reads only the tail of the file (up to ~512 KB) so big logs stay cheap.
async function tail(id, maxLines = 300, q = '') {
  const src = (await sources()).find((s) => s.id === id);
  if (!src) return { error: 'unknown source' };

  let text = '';
  try {
    const stat = fs.statSync(src.path);
    const WINDOW = 512 * 1024;
    const start = Math.max(0, stat.size - WINDOW);
    const fd = fs.openSync(src.path, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
  } catch (err) {
    return { error: `cannot read: ${err.code || err.message}` };
  }

  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (q) { const needle = q.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(needle)); }
  const clamped = Math.max(10, Math.min(2000, Number(maxLines) || 300));
  return { label: src.label, kind: src.kind, lines: lines.slice(-clamped) };
}

module.exports = { sources, publicSources, tail };
