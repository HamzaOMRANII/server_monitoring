'use strict';

// Security panel (M5). Read-only: it looks, it never changes the system.
//
//   SSH       auth.log is read incrementally (position kept in SQLite across
//             restarts and log rotation): failed attempts per hour per IP, and
//             every successful login. One attempt = one sshd process, however
//             many log lines it writes.
//   Ports     `ss -ltnup` listeners, classified against the INPUT rules of
//             iptables/ip6tables: this server only / Cloudflare only / internet.
//   Config    `sshd -T` (root login, password auth), fail2ban, pending apt
//             updates, reboot-required.
//   Findings  plain-language problems with the command to fix each one.
//   Alerts    new port open to the internet, brute-force spike, (optional)
//             every successful SSH login.

const fs = require('node:fs');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const db = require('./db');
const alerts = require('./alerts');
const { notify } = require('./notifier');
const store = require('./store');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const AUTH_LOG = '/var/log/auth.log';
const DEFAULTS = {
  newPublicPort: { enabled: true },
  sshBruteForce: { enabled: true, perHour: 1000, remindMinutes: 360 },
  sshLogin: { enabled: false },
};

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err && !out ? null : String(out || '')));
  });
}

const kvGet = (k, dflt = null) => { const r = db.get('SELECT v FROM kv WHERE k = ?', k); return r ? JSON.parse(r.v) : dflt; };
const kvSet = (k, v) => db.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));

function config(settings) {
  const r = settings.alertRules || {};
  return {
    newPublicPort: { ...DEFAULTS.newPublicPort, ...(r.newPublicPort || {}) },
    sshBruteForce: { ...DEFAULTS.sshBruteForce, ...(r.sshBruteForce || {}) },
    sshLogin: { ...DEFAULTS.sshLogin, ...(r.sshLogin || {}) },
  };
}

// ---------------------------------------------------------------- auth.log
// RFC 3339 (Ubuntu 24.04 rsyslog) or classic "Oct 29 05:11:24".
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function lineTime(line) {
  if (/^\d{4}-\d\d-\d\dT/.test(line)) return Date.parse(line.slice(0, line.indexOf(' ')));
  const m = line.match(/^([A-Z][a-z]{2})\s+(\d+) (\d\d):(\d\d):(\d\d)/);
  if (!m) return NaN;
  const now = new Date();
  const d = new Date(now.getFullYear(), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  if (d - now > DAY) d.setFullYear(d.getFullYear() - 1);
  return d.getTime();
}

const RE_FAIL = /sshd\[(\d+)\]: (?:Failed (?:password|publickey|keyboard-interactive\/pam) for (?:invalid user )?(\S+)|Invalid user (\S*)) from ([0-9a-fA-F.:]+)/;
const RE_OK = /sshd\[\d+\]: Accepted (\S+) for (\S+) from ([0-9a-fA-F.:]+)/;

let parsing = null;
const fresh = []; // successful logins found in this pass (for the optional email)

// Parse `file` from byte `start`; fold failures into hourly buckets.
async function parseFile(file, start, minTs) {
  const buckets = new Map(); // `${hour}|${ip}` -> { count, users:Set }
  const seenPid = new Set();
  let pos = start;
  const stream = fs.createReadStream(file, { start, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    pos += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.includes('sshd[')) continue;
    let m = line.match(RE_FAIL);
    if (m) {
      const ts = lineTime(line);
      if (!(ts >= minTs)) continue;
      if (seenPid.has(m[1])) continue; // one attempt per sshd process
      seenPid.add(m[1]);
      if (seenPid.size > 50000) seenPid.clear();
      const key = `${Math.floor(ts / HOUR) * HOUR}|${m[4]}`;
      const b = buckets.get(key) || { count: 0, users: new Set() };
      b.count++;
      const user = m[2] || m[3];
      if (user && b.users.size < 8) b.users.add(user.slice(0, 32));
      buckets.set(key, b);
      continue;
    }
    m = line.match(RE_OK);
    if (m) {
      const ts = lineTime(line);
      if (!(ts >= minTs)) continue;
      const r = db.run('INSERT OR IGNORE INTO ssh_logins (ts, user, ip, method) VALUES (?, ?, ?, ?)', ts, m[2], m[3], m[1]);
      if (r.changes) fresh.push({ ts, user: m[2], ip: m[3], method: m[1] });
    }
  }
  const up = db.open().prepare(`INSERT INTO ssh_fail_hourly (hour, ip, count, users) VALUES (?, ?, ?, ?)
    ON CONFLICT(hour, ip) DO UPDATE SET count = count + excluded.count,
      users = (SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM (
                 SELECT value FROM json_each(ssh_fail_hourly.users) UNION ALL SELECT value FROM json_each(excluded.users)) LIMIT 8))`);
  db.open().exec('BEGIN');
  try {
    for (const [key, b] of buckets) {
      const [hour, ip] = key.split('|');
      up.run(Number(hour), ip, b.count, JSON.stringify([...b.users]));
    }
    db.open().exec('COMMIT');
  } catch (err) { db.open().exec('ROLLBACK'); throw err; }
  return pos;
}

// Reads what is new since last time, following rotation (auth.log -> auth.log.1).
async function readAuthLog() {
  if (parsing) return parsing;
  parsing = (async () => {
    let st;
    try { st = fs.statSync(AUTH_LOG); } catch { return { available: false }; }
    const state = kvGet('authlog', null);
    const minTs = Date.now() - 7 * DAY;
    if (!state) {
      // first run: backfill the last 7 days from the previous file + the current one
      try { await parseFile(`${AUTH_LOG}.1`, 0, minTs); } catch { /* none */ }
      const pos = await parseFile(AUTH_LOG, 0, minTs);
      kvSet('authlog', { ino: st.ino, pos });
      kvSet('historyStart', minTs);
      kvSet('firstRunAt', Date.now());
    } else if (state.ino !== st.ino || st.size < state.pos) {
      // rotated: finish the old file (now auth.log.1) from where we stopped, then the new one
      try {
        const prev = fs.statSync(`${AUTH_LOG}.1`);
        if (prev.ino === state.ino) await parseFile(`${AUTH_LOG}.1`, state.pos, minTs);
      } catch { /* gone */ }
      const pos = await parseFile(AUTH_LOG, 0, minTs);
      kvSet('authlog', { ino: st.ino, pos });
    } else if (st.size > state.pos) {
      const pos = await parseFile(AUTH_LOG, state.pos, minTs);
      kvSet('authlog', { ino: st.ino, pos });
    }
    return { available: true };
  })().finally(() => { parsing = null; });
  return parsing;
}

// ---------------------------------------------------------------- ports + firewall
async function listeners() {
  const out = await run('ss', ['-ltnupH']);
  const rows = [];
  for (const line of (out || '').split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5) continue;
    const local = c[4];
    const i = local.lastIndexOf(':');
    const addr = local.slice(0, i).replace(/%\w+$/, '');
    const port = Number(local.slice(i + 1));
    const proc = (line.match(/users:\(\("([^"]+)"/) || [])[1] || '?';
    const pid = Number((line.match(/pid=(\d+)/) || [])[1]) || null;
    rows.push({ proto: c[0], addr, port, process: proc, pid });
  }
  return rows;
}

const isLoopback = (a) => /^127\./.test(a) || a === '[::1]' || a === '::1' || a === 'localhost';

// Ports the INPUT chain restricts (jump to a custom chain, DROP/REJECT, or a -s source).
async function firewall() {
  const parse = (txt) => {
    const out = { policy: 'ACCEPT', restricted: new Map() }; // port -> how
    for (const line of (txt || '').split('\n')) {
      if (line.startsWith('-P INPUT')) out.policy = line.split(' ')[2];
      if (!line.startsWith('-A INPUT')) continue;
      const ports = (line.match(/--dports? (\S+)/) || [])[1];
      const target = (line.match(/-j (\S+)/) || [])[1];
      const src = (line.match(/-s (\S+)/) || [])[1];
      if (!ports || !target) continue;
      let how = null;
      if (src && target === 'ACCEPT') how = `only from ${src}`;
      else if (['DROP', 'REJECT'].includes(target)) how = 'blocked';
      else if (!['ACCEPT', 'RETURN', 'LOG'].includes(target)) how = target === 'CF_WEB' ? 'Cloudflare only' : `filtered (${target})`;
      if (!how) continue;
      for (const part of ports.split(',')) {
        const [a, b] = part.split(':').map(Number);
        for (let p = a; p <= (b || a); p++) if (!out.restricted.has(p)) out.restricted.set(p, how);
      }
    }
    return out;
  };
  const [v4, v6] = await Promise.all([run('iptables', ['-S', 'INPUT']), run('ip6tables', ['-S', 'INPUT'])]);
  return { v4: parse(v4), v6: parse(v6), available: v4 !== null };
}

function exposure(l, fw) {
  if (isLoopback(l.addr)) return { level: 'local', label: 'this server only' };
  const v6 = l.addr.startsWith('[') || l.addr.includes(':');
  const rules = v6 ? fw.v6 : fw.v4;
  if (rules.policy !== 'ACCEPT') return { level: 'filtered', label: `firewall default ${rules.policy}` };
  const how = rules.restricted.get(l.port);
  if (how) return { level: 'filtered', label: how };
  return { level: 'internet', label: 'internet' };
}

// ---------------------------------------------------------------- slow checks (cached)
let slow = { at: 0, data: null };
let apt = { at: 0, data: null };
async function slowChecks(force = false) {
  if (!force && slow.data && Date.now() - slow.at < 10 * 60e3) return slow.data;
  const sshdT = await run('sshd', ['-T']);
  const sshd = {};
  for (const line of (sshdT || '').split('\n')) {
    const [k, ...v] = line.trim().split(' ');
    if (['port', 'permitrootlogin', 'passwordauthentication', 'pubkeyauthentication', 'maxauthtries', 'kbdinteractiveauthentication'].includes(k)) sshd[k] = v.join(' ');
  }
  const f2bPath = await run('sh', ['-c', 'command -v fail2ban-client']);
  let fail2ban = { installed: !!(f2bPath && f2bPath.trim()) };
  if (fail2ban.installed) {
    const st = await run('fail2ban-client', ['status', 'sshd']);
    fail2ban = {
      installed: true,
      sshdJail: !!st,
      banned: st ? Number((st.match(/Currently banned:\s+(\d+)/) || [])[1] || 0) : 0,
      totalBanned: st ? Number((st.match(/Total banned:\s+(\d+)/) || [])[1] || 0) : 0,
    };
  }
  let reboot = null;
  try { fs.statSync('/var/run/reboot-required'); reboot = { required: true, packages: (fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').trim().split('\n').filter(Boolean)) }; } catch { reboot = { required: false, packages: [] }; }
  // apt is the slowest: every 6 h
  if (force || !apt.data || Date.now() - apt.at > 6 * HOUR) {
    const out = await run('apt', ['list', '--upgradable'], 30000);
    if (out !== null) {
      const pkgs = out.split('\n').filter((l) => l.includes('/')).map((l) => ({ name: l.split('/')[0], security: /-security/.test(l), to: (l.split(' ')[1] || '') }));
      apt = { at: Date.now(), data: { total: pkgs.length, security: pkgs.filter((p) => p.security).length, packages: pkgs.slice(0, 200) } };
    }
  }
  slow = { at: Date.now(), data: { sshd: sshdT ? sshd : null, fail2ban, reboot, updates: apt.data } };
  return slow.data;
}

// ---------------------------------------------------------------- findings
function findings(ctx) {
  const out = [];
  const add = (level, title, detail, commands = []) => out.push({ level, title, detail, commands });
  const { ssh, sshd, fail2ban, ports, updates, reboot } = ctx;
  const pwAuth = sshd && sshd.passwordauthentication === 'yes';
  const rootPw = sshd && ['yes'].includes(sshd.permitrootlogin);

  if (pwAuth && rootPw) {
    add('crit', 'SSH accepts root logins with a password',
      `${ssh.fails24h.toLocaleString()} failed login attempts in the last 24 h from ${ssh.ips24h} addresses — bots guessing the root password around the clock. One weak or reused password is enough. Use an SSH key and switch passwords off (keep this session open while testing a new one).`,
      ['ssh-copy-id root@<this-server>   # from your own computer first',
        "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && sshd -t && systemctl reload ssh"]);
  } else if (pwAuth) {
    add('warn', 'SSH accepts passwords', 'Keys only is much safer against guessing.', ["sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sshd -t && systemctl reload ssh"]);
  }
  if (!fail2ban.installed && ssh.fails24h > 100) {
    add('crit', 'No fail2ban: attackers can keep guessing forever',
      'fail2ban blocks an address after a few failed logins. With this many attempts it cuts the noise in auth.log and the chance of a lucky guess.',
      ['apt install -y fail2ban && systemctl enable --now fail2ban', 'fail2ban-client status sshd']);
  } else if (fail2ban.installed && !fail2ban.sshdJail) {
    add('warn', 'fail2ban is installed but has no sshd jail', 'It is not protecting SSH.', ['fail2ban-client status']);
  }
  const open = ports.filter((p) => p.exposure.level === 'internet');
  const byPort = (n) => open.filter((p) => p.port === n);
  if (byPort(3389).length) {
    add('warn', 'Remote desktop (RDP 3389) is open to the whole internet',
      'Kept open by your choice. RDP is a frequent target; limiting it to your own address (or a VPN) removes almost all of the risk.',
      ['iptables -I INPUT -p tcp --dport 3389 ! -s <your-ip> -j DROP   # example: allow only your IP']);
  }
  const other = [...new Map(open.filter((p) => ![22, 80, 443, 3389, 3478, 5349].includes(p.port))
    .map((p) => [`${p.proto}/${p.port}`, p])).values()];
  if (other.length) {
    add('warn', `${other.length} other port(s) open to the internet`,
      other.map((p) => `${p.proto}/${p.port} (${p.process})`).join(', ')
        + '. If a service does not need to be public, bind it to 127.0.0.1 or block the port (avahi-daemon = mDNS/printer discovery, not needed on a server: systemctl disable --now avahi-daemon).',
      [`ss -ltnup | grep -E ':(${[...new Set(other.map((p) => p.port))].join('|')})\\b'`]);
  }
  if (ctx.newPorts.length) {
    add('crit', `New port(s) open to the internet: ${ctx.newPorts.map((p) => `${p.proto}/${p.port}`).join(', ')}`,
      'Not in the list of known ports. If you started this service on purpose, mark it as known below.', []);
  }
  if (updates && updates.security > 0) {
    add('warn', `${updates.security} security update(s) waiting`, `${updates.total} package update(s) in total.`, ['apt update && apt upgrade -y']);
  } else if (updates && updates.total > 0) {
    add('info', `${updates.total} package update(s) available`, 'None flagged as security updates.', ['apt update && apt upgrade -y']);
  }
  if (reboot && reboot.required) {
    add('warn', 'A reboot is required', `Installed updates are not active until the server restarts${reboot.packages.length ? ` (${reboot.packages.slice(0, 6).join(', ')})` : ''}.`, ['reboot   # all pm2 apps come back if pm2 startup is configured']);
  }
  if (ssh.newLoginIps.length) {
    add('info', `Successful SSH login(s) from new address(es): ${ssh.newLoginIps.join(', ')}`, 'Never seen before this week. If that was not you, change the root password now and check /var/log/auth.log.', []);
  }
  if (!out.length) add('ok', 'No issues found', 'SSH, firewall, updates and open ports look fine.', []);
  const order = { crit: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------------------------------------------------------------- view + alerts
async function snapshot() {
  const [ls, fw, sl] = await Promise.all([listeners(), firewall(), slowChecks()]);
  const now = Date.now();
  const fails24h = db.get('SELECT COALESCE(SUM(count), 0) AS n, COUNT(DISTINCT ip) AS ips FROM ssh_fail_hourly WHERE hour >= ?', now - DAY);
  const failsLastHour = db.get('SELECT COALESCE(SUM(count), 0) AS n FROM ssh_fail_hourly WHERE hour >= ?', Math.floor(now / HOUR) * HOUR - HOUR);
  const perHour = db.all('SELECT hour AS ts, SUM(count) AS n FROM ssh_fail_hourly WHERE hour >= ? GROUP BY hour ORDER BY hour', now - 7 * DAY);
  const topIps = db.all(`SELECT ip, SUM(count) AS n, MIN(hour) AS first, MAX(hour) AS last,
                           (SELECT json_group_array(DISTINCT value) FROM ssh_fail_hourly h2, json_each(h2.users) WHERE h2.ip = h.ip AND h2.hour >= ?) AS users
                         FROM ssh_fail_hourly h WHERE hour >= ? GROUP BY ip ORDER BY n DESC LIMIT 15`, now - DAY, now - DAY);
  const logins = db.all('SELECT * FROM ssh_logins WHERE ts >= ? ORDER BY ts DESC LIMIT 50', now - 30 * DAY);
  const firstSeen = new Map(db.all('SELECT ip, MIN(ts) AS first FROM ssh_logins GROUP BY ip').map((r) => [r.ip, r.first]));
  // "new" = first seen in the last 7 days AND after the monitor started reading
  // auth.log; addresses from the initial 7-day backfill are the known baseline.
  const historyStart = kvGet('historyStart', now);
  const firstRunAt = kvGet('firstRunAt', historyStart + 7 * DAY);
  const isNew = (ip) => firstSeen.get(ip) >= Math.max(now - 7 * DAY, firstRunAt);
  const newLoginIps = [...new Set(logins.filter((l) => isNew(l.ip)).map((l) => l.ip))];

  const portKey = (p) => `${p.proto}/${p.port}`;
  const ports = [];
  const seen = new Set();
  for (const l of ls) {
    const k = `${l.proto}|${l.addr}|${l.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ports.push({ ...l, exposure: exposure(l, fw) });
  }
  ports.sort((a, b) => ({ internet: 0, filtered: 1, local: 2 }[a.exposure.level] - { internet: 0, filtered: 1, local: 2 }[b.exposure.level]) || a.port - b.port);
  // the first run accepts what is open today as the baseline
  if (!kvGet('knownPorts', null)) kvSet('knownPorts', [...new Set(ports.filter((p) => p.exposure.level === 'internet').map(portKey))]);
  const baseline = new Set(kvGet('knownPorts', []));
  for (const p of ports) p.known = p.exposure.level !== 'internet' || baseline.has(portKey(p));
  const newPorts = ports.filter((p) => !p.known);

  const ssh = {
    available: fs.existsSync(AUTH_LOG),
    fails24h: fails24h.n, ips24h: fails24h.ips, failsLastHour: failsLastHour.n,
    perHour, topIps: topIps.map((r) => ({ ...r, users: JSON.parse(r.users || '[]').slice(0, 8) })),
    logins: logins.map((l) => ({ ...l, newIp: isNew(l.ip) })), newLoginIps, historyStart,
  };
  const ctx = { ssh, sshd: sl.sshd, fail2ban: sl.fail2ban, updates: sl.updates, reboot: sl.reboot, ports, newPorts };
  return { checkedAt: now, firewall: { available: fw.available, v4Policy: fw.v4.policy, v6Policy: fw.v6.policy }, ...ctx, findings: findings(ctx) };
}

async function raise(settings) {
  const cfg = config(settings);
  const server = store.current()?.server || 'server';
  const snap = await snapshot();
  if (cfg.newPublicPort.enabled) {
    const current = new Set(snap.newPorts.map((p) => `${p.proto}/${p.port}`));
    const firing = new Set(alerts.activeAlerts().filter((a) => a.rule === 'newPublicPort').map((a) => a.target));
    for (const k of new Set([...current, ...firing])) {
      const p = snap.newPorts.find((x) => `${x.proto}/${x.port}` === k);
      await alerts.evaluate({
        server, rule: 'newPublicPort', target: k, value: current.has(k) ? 1 : 0, threshold: 1, remindMinutes: 24 * 60, settings,
        describe: () => (p ? `${k} open to the internet (${p.process}${p.pid ? `, pid ${p.pid}` : ''} on ${p.addr})` : `${k} closed or marked as known`),
        subjects: { fire: `🔴 ${server}: new port open to the internet: ${k}`, still: `🔴 (still) ${server}: port ${k} open to the internet`, recover: `🟢 ${server}: port ${k} closed or known` },
      });
    }
  }
  if (cfg.sshBruteForce.enabled) {
    const limit = Math.max(10, Number(cfg.sshBruteForce.perHour) || 1000);
    await alerts.evaluate({
      server, rule: 'sshBruteForce', target: null, value: snap.ssh.failsLastHour, threshold: limit, remindMinutes: cfg.sshBruteForce.remindMinutes, settings,
      describe: (v) => `${v} failed SSH logins since the start of the previous hour (limit ${limit})`,
      subjects: { fire: `🟠 ${server}: SSH brute force — ${snap.ssh.failsLastHour} failed logins in ~1 h`, recover: `🟢 ${server}: SSH login failures back to normal` },
    });
  }
  const logins = fresh.splice(0);
  if (cfg.sshLogin.enabled) {
    for (const l of logins.filter((x) => x.ts >= Date.now() - HOUR)) {
      await notify(settings.receivers, {
        subject: `🔑 ${server}: SSH login ${l.user} from ${l.ip}`,
        text: `${l.user} logged in over SSH from ${l.ip} (${l.method}) at ${new Date(l.ts).toISOString()}. If that was not you, change the password and check /var/log/auth.log.`,
      });
    }
  }
  return snap;
}

function acknowledgePort(key) {
  const k = String(key || '');
  if (!/^(tcp|udp)\/\d{1,5}$/.test(k)) return false;
  kvSet('knownPorts', [...new Set([...(kvGet('knownPorts', []) || []), k])]);
  return true;
}

function prune() {
  db.run('DELETE FROM ssh_fail_hourly WHERE hour < ?', Date.now() - 30 * DAY);
  db.run('DELETE FROM ssh_logins WHERE ts < ?', Date.now() - 90 * DAY);
}

function start(getSettings) {
  const tick = async () => {
    try { await readAuthLog(); await raise(getSettings()); } catch (err) { console.error('[security]', err.message); }
  };
  setTimeout(tick, 8000).unref?.();
  setInterval(tick, 60e3).unref?.();
  setInterval(() => { try { prune(); } catch { /* ignore */ } }, DAY).unref?.();
}

async function view(force = false) {
  if (force) await slowChecks(true);
  await readAuthLog();
  return snapshot();
}

module.exports = { start, view, acknowledgePort, config, DEFAULTS, lineTime, RE_FAIL, RE_OK };
