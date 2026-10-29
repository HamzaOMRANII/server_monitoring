'use strict';

// Email digest (M6): one summary email per day and/or per week, built from what
// the monitor already stores — metrics (M3), alert history (M2), uptime checks
// (M1), per-app restarts and advice (M4) and the security checks (M5).
//
// Schedule (settings.digest): daily at `hour`, weekly on `weekday` at `hour`, in
// `timeZone`. On the weekly day only the weekly digest is sent. The last sent
// period is kept in SQLite, so a restart never sends one twice.

const db = require('./db');
const store = require('./store');
const uptime = require('./uptime');
const apps = require('./apps');
const security = require('./security');
const history = require('./history');
const { notify } = require('./notifier');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DEFAULTS = { daily: true, weekly: true, hour: 8, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RULES = {
  cpuPercent: 'CPU', memPercent: 'RAM', diskPercent: 'Disk', pm2Restart: 'pm2 restarts',
  siteDown: 'Site down', sslExpiry: 'Certificate expiry', newPublicPort: 'New public port', sshBruteForce: 'SSH brute force',
};

function config(settings) {
  const d = { ...DEFAULTS, ...(settings.digest || {}) };
  try { new Intl.DateTimeFormat('en', { timeZone: d.timeZone }); } catch { d.timeZone = 'UTC'; }
  return d;
}

const kvGet = (k) => { const r = db.get('SELECT v FROM kv WHERE k = ?', k); return r ? JSON.parse(r.v) : null; };
const kvSet = (k, v) => db.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));

// Local date/hour/weekday in the digest's time zone.
function localParts(ts, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(ts).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

const fmtDur = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
const mb = (b) => (b == null ? '—' : `${Math.round(b / 1048576)} MB`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Everything the email says, as data.
async function build(period, settings, now = Date.now()) {
  const span = period === 'weekly' ? 7 * DAY : DAY;
  const from = now - span;
  const server = store.current()?.server || 'server';

  const m = db.get(`SELECT AVG(cpu_avg) AS cpu, MAX(cpu_max) AS cpuMax, AVG(mem_avg) AS mem, MAX(mem_max) AS memMax, COUNT(*) AS minutes
                    FROM metric_minutes WHERE minute >= ?`, from);
  const diskFirst = db.get('SELECT disk FROM metric_minutes WHERE minute >= ? AND disk IS NOT NULL ORDER BY minute LIMIT 1', from);
  const diskLast = db.get('SELECT disk FROM metric_minutes WHERE disk IS NOT NULL ORDER BY minute DESC LIMIT 1');
  const diskDelta = diskFirst && diskLast ? diskLast.disk - diskFirst.disk : null;
  const perDay = diskDelta != null && m.minutes > 60 ? diskDelta / (Math.min(span, m.minutes * 60e3) / DAY) : null;
  const daysToFull = perDay > 0.01 && diskLast ? Math.floor((95 - diskLast.disk) / perDay) : null;

  const alertData = history.query({ days: period === 'weekly' ? 7 : 1 });
  const byRule = {};
  for (const e of alertData.events) byRule[e.rule] = (byRule[e.rule] || 0) + 1;

  const up = uptime.view(settings);
  const checks = db.all(`SELECT target, COUNT(*) AS n, SUM(up) AS ok, AVG(ms) AS ms FROM uptime_checks WHERE ts >= ? GROUP BY target`, from);
  const byTarget = new Map(checks.map((c) => [c.target, c]));
  const sites = up.targets.filter((t) => !t.ignored).map((t) => {
    const c = byTarget.get(t.id);
    return { name: t.name, uptime: c && c.n ? (c.ok / c.n) * 100 : null, ms: c ? c.ms : null, up: t.up };
  }).sort((a, b) => (a.uptime ?? 101) - (b.uptime ?? 101));
  const certs = up.targets.filter((t) => !t.ignored).flatMap((t) => t.certs.map((c) => ({ name: t.name, ...c })))
    .sort((a, b) => a.days - b.days);
  const seenCert = new Set();
  const soonCerts = certs.filter((c) => { const k = `${c.subject}|${c.validTo}`; if (seenCert.has(k)) return false; seenCert.add(k); return true; }).slice(0, 4);

  const restarts = apps.restartSummary(span);
  const procs = store.current()?.pm2 || [];
  const advice = await apps.overview().catch(() => ({}));
  const appRows = procs.map((p) => ({
    name: p.name, status: p.status, mem: p.memoryBytes,
    crashes: (restarts[p.name] || {}).crash || 0,
    manual: (restarts[p.name] || {}).manual || 0,
    advice: advice[p.name] && advice[p.name].level !== 'ok' ? advice[p.name] : null,
  }));

  const sec = await security.view().catch(() => null);
  const fails = db.get('SELECT COALESCE(SUM(count), 0) AS n, COUNT(DISTINCT ip) AS ips FROM ssh_fail_hourly WHERE hour >= ?', from);
  const logins = db.all('SELECT * FROM ssh_logins WHERE ts >= ? ORDER BY ts DESC', from);

  const problems = [
    ...sites.filter((s) => s.up === false).map((s) => `${s.name} is down`),
    ...alertData.events.filter((e) => !e.endedAt).map((e) => `${RULES[e.rule] || e.rule}${e.target ? ` · ${e.target}` : ''} still firing`),
    ...appRows.filter((a) => a.advice && a.advice.level === 'crit').map((a) => `${a.name}: ${a.advice.title}`),
    ...(sec ? sec.findings.filter((f) => f.level === 'crit').map((f) => f.title) : []),
    ...(daysToFull != null && daysToFull < 30 ? [`disk full in about ${daysToFull} days at this rate`] : []),
    ...soonCerts.filter((c) => c.days <= 14).map((c) => `certificate ${c.name} expires in ${c.days} d`),
  ];

  return {
    period, server, from, to: now, problems,
    metrics: { ...m, diskNow: diskLast ? diskLast.disk : null, diskDelta, daysToFull },
    alerts: { total: alertData.stats.total, firing: alertData.stats.firing, byRule, siteDownMs: alertData.stats.siteDownMs, top: alertData.events.slice(0, 8) },
    sites, certs: soonCerts, apps: appRows,
    security: {
      fails: fails.n, ips: fails.ips, logins,
      findings: sec ? sec.findings.filter((f) => f.level === 'crit' || f.level === 'warn').map((f) => ({ level: f.level, title: f.title })) : [],
      updates: sec && sec.updates ? sec.updates : null,
    },
  };
}

// ---------------------------------------------------------------- rendering
function subject(d) {
  const label = d.period === 'weekly' ? 'Weekly' : 'Daily';
  return d.problems.length
    ? `${label} report ${d.server}: ${d.problems.length} thing(s) need attention`
    : `${label} report ${d.server}: all good`;
}

function text(d) {
  const L = [];
  const range = `${new Date(d.from).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(d.to).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  L.push(`${d.period === 'weekly' ? 'Weekly' : 'Daily'} report — ${d.server}`, range, '');
  L.push(d.problems.length ? 'NEEDS ATTENTION' : 'ALL GOOD — nothing needs attention.');
  for (const p of d.problems) L.push(`  • ${p}`);
  L.push('', 'SERVER');
  L.push(`  CPU avg ${pct(d.metrics.cpu)}, peak ${pct(d.metrics.cpuMax)} · RAM avg ${pct(d.metrics.mem)}, peak ${pct(d.metrics.memMax)}`);
  L.push(`  Disk ${pct(d.metrics.diskNow)} (${d.metrics.diskDelta == null ? 'no change data' : `${d.metrics.diskDelta >= 0 ? '+' : ''}${d.metrics.diskDelta.toFixed(2)} pts`})${d.metrics.daysToFull != null ? ` · full in ~${d.metrics.daysToFull} d` : ''}`);
  L.push('', 'SITES');
  for (const s of d.sites) L.push(`  ${s.up === false ? 'DOWN' : 'up  '}  ${s.name}  ${s.uptime == null ? '—' : `${s.uptime.toFixed(2)}%`}  ${s.ms == null ? '' : `${Math.round(s.ms)} ms`}`);
  if (d.certs.length) L.push(`  Next certificates: ${d.certs.map((c) => `${c.name} ${c.days} d`).join(', ')}`);
  L.push('', `ALERTS: ${d.alerts.total}${d.alerts.firing ? ` (${d.alerts.firing} still firing)` : ''}${d.alerts.siteDownMs ? ` · site downtime ${fmtDur(d.alerts.siteDownMs)}` : ''}`);
  for (const e of d.alerts.top) L.push(`  ${new Date(e.startedAt).toISOString().slice(5, 16).replace('T', ' ')}  ${RULES[e.rule] || e.rule}${e.target ? ` · ${e.target}` : ''}  ${e.endedAt ? fmtDur(e.durationMs) : 'still firing'}`);
  L.push('', 'APPS (pm2)');
  for (const a of d.apps) L.push(`  ${a.name}: ${a.status}, ${mb(a.mem)}${a.crashes ? `, ${a.crashes} crash(es)` : ''}${a.manual ? `, ${a.manual} manual restart(s)` : ''}${a.advice ? ` — ${a.advice.title}` : ''}`);
  L.push('', 'SECURITY');
  L.push(`  ${d.security.fails.toLocaleString('en')} failed SSH logins from ${d.security.ips} addresses · ${d.security.logins.length} successful login(s)`);
  for (const l of d.security.logins.slice(0, 10)) L.push(`    ${new Date(l.ts).toISOString().slice(5, 16).replace('T', ' ')} ${l.user} from ${l.ip} (${l.method})`);
  for (const f of d.security.findings) L.push(`  ${f.level === 'crit' ? '!' : '-'} ${f.title}`);
  if (d.security.updates) L.push(`  Updates: ${d.security.updates.total} (${d.security.updates.security} security)`);
  L.push('', 'Details: https://monitoring.omranisystems.com');
  return L.join('\n');
}

// Email HTML: tables + inline styles only (mail clients ignore <style> and CSS layout).
function html(d) {
  const C = { ink: '#0F172A', muted: '#64748B', line: '#E2E8F0', bad: '#B91C1C', warn: '#A16207', ok: '#0F766E', bg: '#F8FAFC' };
  const td = 'padding:6px 8px;border-bottom:1px solid ' + C.line + ';font-size:13px;';
  const h2 = (t) => `<h2 style="font:600 15px Arial,sans-serif;color:${C.ink};margin:24px 0 8px">${esc(t)}</h2>`;
  const table = (head, rows) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;color:${C.ink}">
    <tr>${head.map((h) => `<th style="${td}text-align:left;color:${C.muted};font-size:11px;text-transform:uppercase">${esc(h)}</th>`).join('')}</tr>${rows.join('')}</table>`;
  const tag = (word, color) => `<span style="display:inline-block;padding:1px 6px;border:1px solid ${color};border-radius:4px;color:${color};font:600 11px Arial,sans-serif;text-transform:uppercase">${esc(word)}</span>`;
  const stat = (label, value, sub) => `<td style="padding:10px 12px;border:1px solid ${C.line};border-radius:6px;vertical-align:top;width:25%">
      <div style="font:11px Arial,sans-serif;color:${C.muted};text-transform:uppercase">${esc(label)}</div>
      <div style="font:600 20px Arial,sans-serif;color:${C.ink};margin-top:4px">${esc(value)}</div>
      <div style="font:12px Arial,sans-serif;color:${C.muted};margin-top:2px">${esc(sub)}</div></td>`;

  const range = `${new Date(d.from).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} → ${new Date(d.to).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  const status = d.problems.length
    ? `<div style="border-left:4px solid ${C.bad};background:#FEF2F2;padding:12px 14px;font:14px Arial,sans-serif;color:${C.ink}">
        <strong>${d.problems.length} thing(s) need attention</strong><ul style="margin:8px 0 0;padding-left:18px">${d.problems.map((p) => `<li style="margin:3px 0">${esc(p)}</li>`).join('')}</ul></div>`
    : `<div style="border-left:4px solid ${C.ok};background:#F0FDFA;padding:12px 14px;font:14px Arial,sans-serif;color:${C.ink}"><strong>All good</strong> — nothing needs attention.</div>`;

  const x = d.metrics;
  const parts = [
    `<h1 style="font:600 20px Arial,sans-serif;color:${C.ink};margin:0">${d.period === 'weekly' ? 'Weekly' : 'Daily'} report — ${esc(d.server)}</h1>`,
    `<div style="font:12px Arial,sans-serif;color:${C.muted};margin:4px 0 16px">${esc(range)}</div>`,
    status,
    h2('Server'),
    `<table role="presentation" cellspacing="6" cellpadding="0" style="width:100%"><tr>
      ${stat('CPU', pct(x.cpu), `peak ${pct(x.cpuMax)}`)}${stat('RAM', pct(x.mem), `peak ${pct(x.memMax)}`)}
      ${stat('Disk', pct(x.diskNow), x.diskDelta == null ? 'no history yet' : `${x.diskDelta >= 0 ? '+' : ''}${x.diskDelta.toFixed(2)} pts${x.daysToFull != null ? ` · full in ~${x.daysToFull} d` : ''}`)}
      ${stat('Alerts', String(d.alerts.total), d.alerts.firing ? `${d.alerts.firing} still firing` : d.alerts.siteDownMs ? `downtime ${fmtDur(d.alerts.siteDownMs)}` : 'none firing')}
    </tr></table>`,
    h2('Sites'),
    table(['Site', 'Status', 'Uptime', 'Avg response'], d.sites.map((s) => `<tr>
      <td style="${td}font-family:monospace">${esc(s.name)}</td>
      <td style="${td}">${s.up === false ? tag('down', C.bad) : tag('up', C.ok)}</td>
      <td style="${td}">${s.uptime == null ? '—' : `${s.uptime.toFixed(2)}%`}</td>
      <td style="${td}">${s.ms == null ? '—' : `${Math.round(s.ms)} ms`}</td></tr>`)),
    d.certs.length ? `<div style="font:12px Arial,sans-serif;color:${C.muted};margin-top:6px">Next certificate expiries: ${d.certs.map((c) => `${esc(c.name)} (${esc(c.where)}) ${c.days} d`).join(' · ')}</div>` : '',
  ];
  if (d.alerts.top.length) {
    parts.push(h2(`Alerts (${d.alerts.total})`), table(['Started (UTC)', 'Alert', 'Lasted'], d.alerts.top.map((e) => `<tr>
      <td style="${td}">${esc(new Date(e.startedAt).toISOString().slice(5, 16).replace('T', ' '))}</td>
      <td style="${td}">${esc(RULES[e.rule] || e.rule)}${e.target ? ` · <span style="font-family:monospace">${esc(e.target)}</span>` : ''}</td>
      <td style="${td}">${e.endedAt ? esc(fmtDur(e.durationMs)) : tag('still firing', C.bad)}</td></tr>`)));
  }
  parts.push(h2('Apps'), table(['App', 'Status', 'Memory', 'Crashes / manual restarts', 'Advice'], d.apps.map((a) => `<tr>
      <td style="${td}font-family:monospace">${esc(a.name)}</td>
      <td style="${td}">${esc(a.status)}</td><td style="${td}">${esc(mb(a.mem))}</td>
      <td style="${td}">${a.crashes ? `<strong style="color:${C.bad}">${a.crashes}</strong>` : '0'} / ${a.manual}</td>
      <td style="${td}">${a.advice ? `${tag(a.advice.level === 'crit' ? 'problem' : a.advice.level === 'warn' ? 'warning' : 'note', a.advice.level === 'crit' ? C.bad : C.warn)} ${esc(a.advice.title)}` : '<span style="color:' + C.ok + '">ok</span>'}</td></tr>`)));
  const s = d.security;
  parts.push(h2('Security'),
    `<div style="font:13px Arial,sans-serif;color:${C.ink}"><strong>${s.fails.toLocaleString('en')}</strong> failed SSH logins from <strong>${s.ips}</strong> addresses · <strong>${s.logins.length}</strong> successful login(s)${s.updates ? ` · ${s.updates.total} update(s) (${s.updates.security} security)` : ''}</div>`,
    s.logins.length ? table(['When (UTC)', 'User', 'From', 'Method'], s.logins.slice(0, 10).map((l) => `<tr>
      <td style="${td}">${esc(new Date(l.ts).toISOString().slice(5, 16).replace('T', ' '))}</td><td style="${td}">${esc(l.user)}</td>
      <td style="${td}font-family:monospace">${esc(l.ip)}</td><td style="${td}">${esc(l.method)}</td></tr>`)) : '',
    s.findings.length ? `<ul style="font:13px Arial,sans-serif;color:${C.ink};padding-left:18px">${s.findings.map((f) => `<li style="margin:3px 0">${tag(f.level === 'crit' ? 'problem' : 'warning', f.level === 'crit' ? C.bad : C.warn)} ${esc(f.title)}</li>`).join('')}</ul>` : '');
  parts.push(`<p style="font:12px Arial,sans-serif;color:${C.muted};margin-top:24px">Details: <a href="https://monitoring.omranisystems.com" style="color:${C.ok}">monitoring.omranisystems.com</a> · change or stop this report in Settings → Email digest.</p>`);
  return `<!doctype html><html><body style="margin:0;background:${C.bg}"><div style="max-width:680px;margin:0 auto;padding:24px 16px;background:#fff">${parts.join('\n')}</div></body></html>`;
}

async function send(period, settings, { force = false } = {}) {
  const d = await build(period, settings);
  const res = await notify(settings.receivers, { subject: subject(d), text: text(d), html: html(d) });
  const ok = res.length > 0 && res.every(([, r]) => r);
  if (!force) console.log(`[digest] ${period} digest ${ok ? 'sent' : 'not sent (email off or failed)'}`);
  return { ok, subject: subject(d), problems: d.problems.length };
}

// Called every few minutes: sends what is due, once per local day / week.
async function tick(settings, now = Date.now()) {
  const c = config(settings);
  const t = localParts(now, c.timeZone);
  if (t.hour < c.hour) return null;
  const weeklyToday = c.weekly && t.weekday === Number(c.weekday);
  if (weeklyToday && kvGet('digest:weekly') !== t.date) {
    kvSet('digest:weekly', t.date);
    kvSet('digest:daily', t.date); // the weekly one replaces that day's daily
    return send('weekly', settings);
  }
  if (c.daily && !weeklyToday && kvGet('digest:daily') !== t.date) {
    kvSet('digest:daily', t.date);
    return send('daily', settings);
  }
  return null;
}

function start(getSettings) {
  // first install: do not fire a digest for "today" if it is already past the hour
  const c = config(getSettings());
  const t = localParts(Date.now(), c.timeZone);
  if (kvGet('digest:daily') === null && t.hour >= c.hour) { kvSet('digest:daily', t.date); kvSet('digest:weekly', t.date); }
  const run = () => tick(getSettings()).catch((err) => console.error('[digest]', err.message));
  setInterval(run, 5 * 60e3).unref?.();
}

async function preview(period, settings) {
  const d = await build(period, settings);
  return { subject: subject(d), html: html(d), text: text(d) };
}

function schedule(settings) {
  const c = config(settings);
  return { ...c, weekdayName: WEEKDAYS[c.weekday] || '?', lastDaily: kvGet('digest:daily'), lastWeekly: kvGet('digest:weekly') };
}

module.exports = { start, tick, send, preview, build, schedule, config, localParts, DEFAULTS };
