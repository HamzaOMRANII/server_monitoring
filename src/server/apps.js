'use strict';

// Per-app view + advice (M4). For one pm2 app: its current state, the TCP ports
// its process tree listens on, the nginx sites that route to it, CPU/memory over
// time (pm2_minutes from M3) with restarts marked, the tail of its logs, and a
// list of findings, each with a plain-language explanation and the command to
// run. Read-only: nothing here changes the app.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const store = require('./store');
const metrics = require('./metrics');
const db = require('./db');

const HOUR = 3600e3;
const MB = 1024 * 1024;
const LEVELS = { crit: 0, warn: 1, info: 2, ok: 3 };

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// pid -> ["127.0.0.1:17000", ...] from `ss -ltnp`
async function listeners() {
  const out = await run('ss', ['-ltnpH']);
  const byPid = new Map();
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const addr = cols[3];
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (!byPid.has(pid)) byPid.set(pid, new Set());
      byPid.get(pid).add(addr);
    }
  }
  return byPid;
}

// ppid -> [child pids], read from /proc (Linux); empty elsewhere.
function processTree() {
  const children = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return children; }
  for (const d of dirs) {
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(d));
    } catch { /* process exited */ }
  }
  return children;
}

function portsOf(pid, byPid, tree) {
  const out = new Set();
  const stack = pid ? [pid] : [];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const a of byPid.get(p) || []) out.add(a);
    for (const c of tree.get(p) || []) stack.push(c);
  }
  return [...out].sort();
}

const portNum = (addr) => Number(String(addr).split(':').pop());

// nginx sites whose upstream is this port on the local box.
function sitesForPort(port) {
  if (!port) return [];
  const sites = store.current()?.nginx?.sites || [];
  return sites.filter((s) => (s.upstreams || []).some((u) => {
    const m = String(u).match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/);
    return m && Number(m[1]) === port;
  })).flatMap((s) => s.serverNames);
}

// Restarts per minute from the stored counter (pm2's restart_time only goes up,
// except after `pm2 reset` / a pm2 daemon restart, which we ignore).
function restartEvents(name, sinceMs) {
  const rows = db.all('SELECT minute, restarts FROM pm2_minutes WHERE name = ? AND minute >= ? ORDER BY minute', name, Date.now() - sinceMs);
  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const d = (rows[i].restarts ?? 0) - (rows[i - 1].restarts ?? 0);
    if (d > 0) events.push({ ts: rows[i].minute, count: d });
  }
  return events;
}

// Least-squares fit of memory (hourly averages) since the last restart.
function memoryTrend(name) {
  const since = Date.now() - 7 * 24 * HOUR;
  const restarts = restartEvents(name, 7 * 24 * HOUR);
  const from = Math.max(since, restarts.length ? restarts[restarts.length - 1].ts : since);
  const rows = db.all(`SELECT (minute / ${HOUR}) * ${HOUR} AS ts, AVG(mem_avg) AS mem FROM pm2_minutes
                       WHERE name = ? AND minute >= ? AND mem_avg IS NOT NULL GROUP BY 1 ORDER BY 1`, name, from);
  if (rows.length < 12) return { hours: rows.length, enough: false };
  const n = rows.length;
  const xs = rows.map((r) => (r.ts - rows[0].ts) / HOUR);
  const ys = rows.map((r) => r.mem);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0; // bytes per hour
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { enough: true, hours: n, perDayBytes: slope * 24, r2, first: ys[0], last: ys[n - 1] };
}

// Last `n` lines of a pm2 log. pm2-logrotate empties the live file every night,
// so when it is short the newest rotated copy (name__YYYY-MM-DD_….log) is read too.
function readTail(file, n) {
  const tailOf = (f) => {
    const st = fs.statSync(f);
    const start = Math.max(0, st.size - 256 * 1024);
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines;
    } finally { fs.closeSync(fd); }
  };
  let lines = [];
  let rotated = null;
  try { lines = tailOf(file); } catch { return { lines: [], rotated: null, mtime: null }; }
  if (lines.length < n) {
    const dir = path.dirname(file);
    const stem = path.basename(file).replace(/\.log$/, '');
    const older = fs.readdirSync(dir).filter((f) => f.startsWith(`${stem}__`)).sort();
    if (older.length) {
      rotated = older[older.length - 1];
      try { lines = [...tailOf(path.join(dir, rotated)), `──── live log (${path.basename(file)}) ────`, ...lines]; } catch { rotated = null; }
    }
  }
  let mtime = null;
  try { mtime = fs.statSync(file).mtimeMs; } catch {}
  return { lines: lines.slice(-n), rotated, mtime };
}

function errLogInfo(proc) {
  if (!proc.errLog) return null;
  const t = readTail(proc.errLog, 40);
  // only the live file counts as "recent"; rotated lines are context
  return { mtime: t.mtime, lines: t.lines, rotated: t.rotated };
}

const lastError = (lines) => [...(lines || [])].reverse().find((l) => /error|exception|fatal|cannot|failed|refused|EADDRINUSE|ENOENT/i.test(l)) || (lines || []).slice(-1)[0] || null;
const mb = (b) => `${Math.round(b / MB)} MB`;

// Findings, most severe first. `ctx` carries what was measured.
function advise(p, ctx) {
  const out = [];
  const add = (level, title, detail, commands = []) => out.push({ level, title, detail, commands });
  const status = String(p.status || 'unknown').toLowerCase();

  if (status !== 'online') {
    add('crit', `The app is ${status}`, ctx.err && lastError(ctx.err.lines) ? `Last error line: ${lastError(ctx.err.lines)}` : 'pm2 is not running it.',
      [`pm2 logs ${p.name} --err --lines 50`, `pm2 restart ${p.name}`]);
  }
  if (p.cwd && ctx.cwdExists === false) {
    add('crit', 'Its code folder does not exist',
      `pm2 runs it from ${p.cwd}, which is missing. pm2 can still show "online" because only the launcher (${(p.script || '').split('/').pop() || 'script'}) is running, but the app itself is not.`,
      [`ls -la ${p.cwd}`, `pm2 delete ${p.name} && pm2 save   # if the app was retired`]);
  }
  if (status === 'online' && p.port && !ctx.ports.some((a) => portNum(a) === p.port) && ctx.portHolder) {
    const h = ctx.portHolder;
    const sites = sitesForPort(p.port);
    add('crit', `Its port ${p.port} is held by a process pm2 does not manage`,
      `pid ${h.pid} (${h.cmd}${h.cwd ? `, in ${h.cwd}` : ''}${h.started ? `, started ${h.started}` : ''}) listens on ${p.port}${h.pm2App ? `; it belongs to pm2 app "${h.pm2App}"` : ' and is an orphan left from an earlier start'}. pm2's own copy of "${p.name}" cannot bind the port, so ${sites.length ? `${sites.join(', ')} is served by that old process and ` : ''}deploys and \`pm2 restart ${p.name}\` do not take effect.`,
      h.pm2App ? [`pm2 describe ${h.pm2App}`] : [`kill ${h.pid} && pm2 restart ${p.name}`, `ss -ltnp | grep :${p.port}`]);
  } else if (status === 'online' && p.port && !ctx.ports.some((a) => portNum(a) === p.port)) {
    const sites = sitesForPort(p.port);
    add('crit', `Nothing listens on its port ${p.port}`,
      `PORT=${p.port} is set for this app but no process in its tree listens there${sites.length ? `, so ${sites.join(', ')} cannot reach it (visitors behind the access gate may not notice)` : ''}.`,
      [`pm2 logs ${p.name} --lines 50`, `ss -ltnp | grep :${p.port}`]);
  }

  const lastHour = ctx.restarts.filter((r) => r.ts >= Date.now() - HOUR).reduce((s, r) => s + r.count, 0);
  if (lastHour >= 3 || (lastHour > 0 && (p.unstableRestarts || 0) > 0)) {
    add('crit', `Crash loop: ${lastHour} restart(s) in the last hour`,
      `${ctx.err && lastError(ctx.err.lines) ? `Last error line: ${lastError(ctx.err.lines)}. ` : ''}The app starts and dies; restarting again will not fix it — the error above usually names the cause (missing env, port in use, failed dependency).`,
      [`pm2 logs ${p.name} --err --lines 100`, `pm2 describe ${p.name}`]);
  } else if (lastHour > 0) {
    add('warn', `Restarted ${lastHour} time(s) in the last hour`, 'If nobody deployed or restarted it, it crashed: check the error log.', [`pm2 logs ${p.name} --err --lines 50`]);
  }

  const t = ctx.trend;
  if (t.enough && t.perDayBytes > 20 * MB && t.r2 > 0.7 && t.last > t.first * 1.25) {
    const daysTo = ctx.memTotal ? (ctx.memTotal * 0.25 - t.last) / t.perDayBytes : null;
    add('warn', 'Memory keeps growing (possible leak)',
      `+${mb(t.perDayBytes)} per day over the last ${t.hours} h since its last restart (${mb(t.first)} → ${mb(t.last)}, steady trend R²=${t.r2.toFixed(2)}).${daysTo && daysTo > 0 ? ` At this rate it reaches a quarter of the server's RAM in about ${Math.ceil(daysTo)} day(s).` : ''} A restart frees it for now; the fix is in the code (caches or listeners that are never released).`,
      [`pm2 restart ${p.name}`, `pm2 monit`]);
  }
  if (ctx.memTotal && p.memoryBytes > ctx.memTotal * 0.25) {
    add('warn', `Uses ${mb(p.memoryBytes)} — over a quarter of the server's RAM`, 'Other apps may run short of memory. Consider a memory cap so pm2 restarts it before it hurts the others.',
      [`pm2 restart ${p.name} --max-memory-restart ${Math.round((ctx.memTotal * 0.25) / MB)}M`]);
  }
  if (ctx.cpu1h != null && ctx.cpu1h > 80) {
    add('warn', `Busy: ${ctx.cpu1h.toFixed(0)}% CPU on average over the last hour`, 'One core is almost fully used by this app. Check for a loop, a heavy job or unusual traffic.', [`pm2 monit`, `pm2 logs ${p.name} --lines 100`]);
  } else if (ctx.cpu1h != null && ctx.cpu1h > 50) {
    add('info', `${ctx.cpu1h.toFixed(0)}% CPU on average over the last hour`, 'Higher than usual for a small web app.', []);
  }
  if (ctx.err && ctx.err.mtime && ctx.err.lines.length && !/^──── live log/.test(ctx.err.lines[ctx.err.lines.length - 1]) && Date.now() - ctx.err.mtime < HOUR && status === 'online' && !out.some((o) => o.level === 'crit')) {
    add('info', `Error log written ${Math.max(1, Math.round((Date.now() - ctx.err.mtime) / 60000))} min ago`, `Last line: ${ctx.err.lines[ctx.err.lines.length - 1].slice(0, 300)}`, [`pm2 logs ${p.name} --err --lines 50`]);
  }
  if ((p.restarts || 0) >= 20 && !ctx.restarts.some((r) => r.ts >= Date.now() - 24 * HOUR)) {
    add('info', `${p.restarts} restarts in total, none in the last 24 h`, 'It is stable now; the counter just remembers older crashes or deploys.', [`pm2 reset ${p.name}   # sets the counter back to 0`]);
  }
  if (!out.length) add('ok', 'No issues found', 'Running, listening where expected, no recent restarts, memory and CPU look normal.', []);
  return out.sort((a, b) => LEVELS[a.level] - LEVELS[b.level]);
}

// Who listens on `port` on the loopback/any address when the app itself does not.
function holderOf(port, byPid, tree) {
  for (const [pid, addrs] of byPid) {
    if (![...addrs].some((a) => portNum(a) === port && !/^(?!127\.|0\.0\.0\.0|\*|\[::)/.test(a))) continue;
    let cmd = '', cwd = null, started = null;
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch {}
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
    try { started = `${new Date(fs.statSync(`/proc/${pid}`).mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`; } catch {}
    if (/nginx/.test(cmd)) continue;
    const owner = (store.current()?.pm2 || []).find((q) => q.pid && portsOf(q.pid, new Map([[pid, addrs]]), tree).length);
    return { pid, cmd: cmd.slice(0, 120) || 'unknown', cwd, started, pm2App: owner ? owner.name : null };
  }
  return null;
}

async function context(p, { withLogs }) {
  const [byPid, tree] = [await listeners(), processTree()];
  let cwdExists = null;
  if (p.cwd) { try { cwdExists = fs.statSync(p.cwd).isDirectory(); } catch { cwdExists = false; } }
  const cpuRow = db.get('SELECT AVG(cpu_avg) AS c FROM pm2_minutes WHERE name = ? AND minute >= ?', p.name, Date.now() - HOUR);
  const ports = portsOf(p.pid, byPid, tree);
  return {
    ports,
    portHolder: p.port && !ports.some((a) => portNum(a) === p.port) ? holderOf(p.port, byPid, tree) : null,
    cwdExists,
    restarts: restartEvents(p.name, 7 * 24 * HOUR),
    trend: memoryTrend(p.name),
    cpu1h: cpuRow && cpuRow.c != null ? cpuRow.c : null,
    memTotal: store.current()?.memory?.totalBytes || null,
    err: withLogs ? errLogInfo(p) : null,
  };
}

function findProc(name) {
  return (store.current()?.pm2 || []).find((p) => p.name === name) || null;
}

// Worst finding per app, for the dashboard table (no log reads).
async function overview() {
  const out = {};
  for (const p of store.current()?.pm2 || []) {
    try {
      const a = advise(p, await context(p, { withLogs: false }));
      out[p.name] = { level: a[0].level, title: a[0].title, count: a.filter((x) => x.level !== 'ok').length };
    } catch (err) {
      out[p.name] = { level: 'info', title: `could not analyse: ${err.message}`, count: 0 };
    }
  }
  return out;
}

async function detail(name, range) {
  const p = findProc(name);
  if (!p) return null;
  const ctx = await context(p, { withLogs: true });
  const out = p.outLog ? readTail(p.outLog, 40) : { lines: [], rotated: null };
  const series = metrics.appSeries(name, range);
  return {
    app: p,
    ports: ctx.ports,
    sites: [...new Set(ctx.ports.map(portNum).concat(p.port ? [p.port] : []).flatMap(sitesForPort))],
    cwdExists: ctx.cwdExists,
    advice: advise(p, ctx),
    series,
    restarts: ctx.restarts.filter((r) => r.ts >= series.from),
    logs: { err: ctx.err ? ctx.err.lines : [], out: out.lines, errRotated: ctx.err ? ctx.err.rotated : null, outRotated: out.rotated },
  };
}

module.exports = { overview, detail, advise };
