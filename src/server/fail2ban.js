'use strict';

// fail2ban (sshd jail): the ban list for the Console / Security pages and the
// write operations behind the Console buttons. Reads `fail2ban-client` and its
// SQLite history (/var/lib/fail2ban/fail2ban.sqlite3, table bips = repeat-ban counter);
// joins the monitor's own SSH history (ssh_fail_hourly) for attempts + user names.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { execFile } = require('node:child_process');
const db = require('./db');

const JAIL = 'sshd';
const F2B_DB = '/var/lib/fail2ban/fail2ban.sqlite3';
const JAIL_FILE = process.env.F2B_JAIL_FILE || '/etc/fail2ban/jail.d/omrani-sshd.local';
const DAY = 24 * 3600e3;

function run(args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile('fail2ban-client', args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(out || ''), err: String(errOut || '') }));
  });
}

// "1.2.3.4 \t2026-10-29 05:45:44 + 3600 = 2026-10-29 06:45:44"  (server local time)
function parseBanTimes(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*\+\s*(-?\d+)\s*=\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/);
    if (m && net.isIP(m[1])) out.push({ ip: m[1], since: Date.parse(m[2].replace(' ', 'T')), bantimeSec: Number(m[3]), until: Number(m[3]) < 0 ? null : Date.parse(m[4].replace(' ', 'T')) });
  }
  return out;
}

function banCounts() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(F2B_DB, { readOnly: true });
    const rows = d.prepare('SELECT ip, MAX(bancount) AS n FROM bips WHERE jail = ? GROUP BY ip').all(JAIL);
    d.close();
    return new Map(rows.map((r) => [r.ip, r.n]));
  } catch { return new Map(); }
}

function readIgnoreFile() {
  try {
    const text = fs.readFileSync(JAIL_FILE, 'utf8');
    const m = text.match(/^ignoreip\s*=\s*(.*)$/m);
    return { text, list: m ? m[1].trim().split(/[\s,]+/).filter(Boolean) : [] };
  } catch { return { text: null, list: [] }; }
}

async function view() {
  const st = await run(['status', JAIL]);
  if (!st.ok) return { available: false, reason: (st.err || st.out || 'fail2ban-client not available').trim().slice(0, 200) };
  const [times, bantime, findtime, maxretry] = await Promise.all([
    run(['get', JAIL, 'banip', '--with-time']), run(['get', JAIL, 'bantime']), run(['get', JAIL, 'findtime']), run(['get', JAIL, 'maxretry']),
  ]);
  const counts = banCounts();
  const since = Date.now() - DAY;
  const attempts = new Map(db.all(`SELECT ip, SUM(count) AS n, MAX(hour) AS last FROM ssh_fail_hourly WHERE hour >= ? GROUP BY ip`, since).map((r) => [r.ip, r]));
  const users = (ip) => {
    const rows = db.all(`SELECT DISTINCT value FROM ssh_fail_hourly, json_each(ssh_fail_hourly.users) WHERE ip = ? AND hour >= ? LIMIT 8`, ip, since - 6 * DAY);
    return rows.map((r) => r.value);
  };
  const banned = parseBanTimes(times.out).map((b) => ({
    ...b,
    remainingSec: b.until ? Math.max(0, Math.round((b.until - Date.now()) / 1000)) : null,
    timesBanned: counts.get(b.ip) || 1,
    attempts24h: (attempts.get(b.ip) || {}).n || 0,
    users: users(b.ip),
  })).sort((a, b) => b.since - a.since);
  const num = (r) => Number((r.out || '').trim()) || null;
  return {
    available: true, jail: JAIL,
    rules: { bantimeSec: num(bantime), findtimeSec: num(findtime), maxretry: num(maxretry) },
    currentlyFailed: Number((st.out.match(/Currently failed:\s+(\d+)/) || [])[1] || 0),
    totalBanned: Number((st.out.match(/Total banned:\s+(\d+)/) || [])[1] || 0),
    banned,
    allowed: readIgnoreFile().list,
    serverIps: serverIps(),
    jailFile: JAIL_FILE,
  };
}

function serverIps() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) out.push(a.address);
  return out;
}

// Addresses that must never be banned from here: loopback, this server, the caller.
function protectedReason(ip, callerIp) {
  if (/^127\.|^::1$|^0\.0\.0\.0$/.test(ip)) return 'a loopback address';
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) if (a.address === ip) return "this server's own address";
  if (callerIp && ip === callerIp) return 'your own current address (you would lock yourself out of SSH)';
  if (readIgnoreFile().list.includes(ip)) return 'on the allow-list (remove it from the allow-list first)';
  return null;
}

// "Unban & forget": unban and drop the repeat-ban history, so a future ban starts at the base time again.
async function forget(ip) {
  const r = await run(['set', JAIL, 'unbanip', ip]);
  let removed = 0;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(F2B_DB);
    d.exec('PRAGMA busy_timeout = 3000');
    removed = d.prepare('DELETE FROM bips WHERE ip = ? AND jail = ?').run(ip, JAIL).changes;
    d.close();
  } catch (err) {
    return { ok: false, code: 1, output: `${r.out.trim()}\nhistory not cleared: ${err.message}` };
  }
  return { ok: true, code: 0, output: `${r.ok ? `unbanned ${ip}` : `${ip} was not banned`}; repeat-ban history cleared (${removed} record(s))` };
}

// Allow-list (fail2ban ignoreip): applied now AND written to the jail file, so it survives restarts.
async function setAllowed(ip, allow) {
  const { text, list } = readIgnoreFile();
  if (text === null) return { ok: false, code: 1, output: `cannot read ${JAIL_FILE}` };
  const next = allow ? [...new Set([...list, ip])] : list.filter((x) => x !== ip);
  if (!allow && (/^127\.|^::1$/.test(ip) || serverIps().includes(ip))) return { ok: false, code: 1, output: `${ip} stays allowed (loopback / this server)` };
  const line = `ignoreip = ${next.join(' ')}`;
  const updated = /^ignoreip\s*=.*$/m.test(text) ? text.replace(/^ignoreip\s*=.*$/m, line) : text.replace(/^\[DEFAULT\]\s*$/m, `[DEFAULT]\n${line}`);
  fs.writeFileSync(`${JAIL_FILE}.tmp`, updated);
  fs.renameSync(`${JAIL_FILE}.tmp`, JAIL_FILE);
  const r = await run(['set', JAIL, allow ? 'addignoreip' : 'delignoreip', ip]);
  if (allow) await run(['set', JAIL, 'unbanip', ip]);
  return { ok: r.ok, code: r.code, output: `${allow ? 'allowed (never banned)' : 'removed from the allow-list'}: ${ip}\n${JAIL_FILE}: ${line}` };
}

module.exports = { view, protectedReason, forget, setAllowed, run, JAIL };
