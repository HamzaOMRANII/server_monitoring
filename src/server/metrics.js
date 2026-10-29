'use strict';

// Metrics history (M3). The sampler feeds every 10 s snapshot here; samples are
// folded into one row per minute (average + peak) and written to SQLite, with a
// row per pm2 app. The last hour at full 10 s resolution stays in memory
// (store.js); longer ranges are read back from SQLite, bucketed to ~300 points.
//
// Retention: minutes 90 days, pm2 + uptime checks 30 days (pruned daily).

const db = require('./db');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const KEEP = { minutes: 90 * DAY, pm2: 30 * DAY, checks: 30 * DAY };
const RANGES = { '1h': 60 * MINUTE, '6h': 6 * 60 * MINUTE, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };
const POINTS = 300;

let bucket = null; // { minute, n, cpu[], mem[], disk, load1, apps: Map }

function safe(fn) {
  try { return fn(); } catch (err) { console.error('[metrics]', err.message); return null; }
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const max = (a) => (a.length ? Math.max(...a) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function mainDiskPercent(s) {
  const disks = (s && s.disks) || [];
  if (!disks.length) return null;
  return disks.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a), disks[0]).usedPercent;
}

// Called by the sampler with each snapshot.
function add(snapshot) {
  const minute = Math.floor(snapshot.ts / MINUTE) * MINUTE;
  if (bucket && bucket.minute !== minute) flush();
  if (!bucket) bucket = { minute, n: 0, cpu: [], mem: [], disk: null, load1: null, apps: new Map() };
  bucket.n++;
  if (num(snapshot.cpuPercent) !== null) bucket.cpu.push(snapshot.cpuPercent);
  if (num(snapshot.memPercent) !== null) bucket.mem.push(snapshot.memPercent);
  bucket.disk = num(mainDiskPercent(snapshot)) ?? bucket.disk;
  bucket.load1 = num(snapshot.specs && snapshot.specs.loadavg && snapshot.specs.loadavg[0]) ?? bucket.load1;
  for (const p of snapshot.pm2 || []) {
    const a = bucket.apps.get(p.name) || { cpu: [], mem: [], restarts: null, online: true };
    if (num(p.cpu) !== null) a.cpu.push(p.cpu);
    if (num(p.memoryBytes) !== null) a.mem.push(p.memoryBytes);
    a.restarts = p.restarts ?? a.restarts;
    a.online = a.online && String(p.status).toLowerCase() === 'online';
    bucket.apps.set(p.name, a);
  }
}

function flush() {
  const b = bucket;
  bucket = null;
  if (!b || !b.n) return;
  safe(() => {
    db.run(`INSERT OR REPLACE INTO metric_minutes (minute, cpu_avg, cpu_max, mem_avg, mem_max, disk, load1, samples)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, b.minute, avg(b.cpu), max(b.cpu), avg(b.mem), max(b.mem), b.disk, b.load1, b.n);
    const ins = db.open().prepare(`INSERT OR REPLACE INTO pm2_minutes (minute, name, cpu_avg, mem_avg, restarts, online)
                                   VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [name, a] of b.apps) ins.run(b.minute, name, avg(a.cpu), a.mem.length ? Math.round(avg(a.mem)) : null, a.restarts, a.online ? 1 : 0);
  });
}

function recordCheck(target, ts, up, ms) {
  safe(() => db.run('INSERT OR REPLACE INTO uptime_checks (target, ts, up, ms) VALUES (?, ?, ?, ?)', target, ts, up ? 1 : 0, ms ?? null));
}

// Checks of the last `sinceMs` per target (to refill the uptime page after a restart).
function recentChecks(sinceMs) {
  return safe(() => db.all('SELECT target, ts, up, ms FROM uptime_checks WHERE ts >= ? ORDER BY ts', Date.now() - sinceMs)) || [];
}

// Uptime % per target over the last `sinceMs`.
function uptimePercents(sinceMs) {
  const rows = safe(() => db.all(`SELECT target, COUNT(*) AS n, SUM(up) AS ok FROM uptime_checks WHERE ts >= ? GROUP BY target`,
    Date.now() - sinceMs)) || [];
  return Object.fromEntries(rows.map((r) => [r.target, Math.round((r.ok / r.n) * 1000) / 10]));
}

// Server series for a range, bucketed: [{ ts, cpu, cpuMax, mem, memMax, disk, load1 }].
function series(range) {
  const span = RANGES[range] || RANGES['24h'];
  const step = Math.max(MINUTE, Math.ceil(span / POINTS / MINUTE) * MINUTE);
  const from = Date.now() - span;
  const rows = safe(() => db.all(`
    SELECT (minute / ?) * ? AS ts,
           AVG(cpu_avg) AS cpu, MAX(cpu_max) AS cpuMax, AVG(mem_avg) AS mem, MAX(mem_max) AS memMax,
           AVG(disk) AS disk, AVG(load1) AS load1
    FROM metric_minutes WHERE minute >= ? GROUP BY 1 ORDER BY 1`, step, step, from)) || [];
  return { range, from, to: Date.now(), stepMs: step, points: rows.map(round) };
}

// One pm2 app over a range (used by the per-app view in M4).
function appSeries(name, range) {
  const span = RANGES[range] || RANGES['24h'];
  const step = Math.max(MINUTE, Math.ceil(span / POINTS / MINUTE) * MINUTE);
  const from = Date.now() - span;
  const rows = safe(() => db.all(`
    SELECT (minute / ?) * ? AS ts, AVG(cpu_avg) AS cpu, AVG(mem_avg) AS mem, MAX(restarts) AS restarts, MIN(online) AS online
    FROM pm2_minutes WHERE name = ? AND minute >= ? GROUP BY 1 ORDER BY 1`, step, step, name, from)) || [];
  return { range, from, to: Date.now(), stepMs: step, points: rows };
}

function round(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'number' && k !== 'ts' ? Math.round(v * 10) / 10 : v;
  return o;
}

function prune() {
  safe(() => {
    const now = Date.now();
    db.run('DELETE FROM metric_minutes WHERE minute < ?', now - KEEP.minutes);
    db.run('DELETE FROM pm2_minutes WHERE minute < ?', now - KEEP.pm2);
    db.run('DELETE FROM uptime_checks WHERE ts < ?', now - KEEP.checks);
  });
}

function start() {
  prune();
  const t = setInterval(prune, DAY);
  t.unref?.();
}

module.exports = { add, flush, recordCheck, recentChecks, uptimePercents, series, appSeries, start, RANGES };
