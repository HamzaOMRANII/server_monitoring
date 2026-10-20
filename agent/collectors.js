'use strict';

// Collectors read the local box and return plain data. Everything degrades
// gracefully: if pm2 or nginx isn't present, that field comes back empty
// rather than throwing, so the agent runs anywhere.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toString());
    });
  });
}

// CPU %: sample os.cpus() times twice, `ms` apart, and diff the idle fraction.
function cpuTimes() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuPercent(ms = 1000) {
  return new Promise((resolve) => {
    const a = cpuTimes();
    setTimeout(() => {
      const b = cpuTimes();
      const idleDelta = b.idle - a.idle;
      const totalDelta = b.total - a.total;
      const pct = totalDelta > 0 ? 100 * (1 - idleDelta / totalDelta) : 0;
      resolve(Math.max(0, Math.min(100, pct)));
    }, ms);
  });
}

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { totalBytes: total, usedBytes: used, usedPercent: total ? (100 * used) / total : 0 };
}

// Disks via `df -kP` (POSIX, portable output).
async function disks() {
  const out = await run('df', ['-kP']);
  if (!out) return [];
  return out.trim().split('\n').slice(1).map((line) => {
    const p = line.trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const totalKb = Number(p[1]); const usedKb = Number(p[2]); const mount = p[5];
    return {
      filesystem: p[0], mount,
      totalBytes: totalKb * 1024, usedBytes: usedKb * 1024,
      usedPercent: totalKb ? (100 * usedKb) / totalKb : 0,
    };
  }).filter((d) => d.mount && !d.mount.startsWith('/dev') && !d.mount.startsWith('/sys') && !d.mount.startsWith('/proc'));
}

// pm2 process list via `pm2 jlist`.
async function pm2() {
  const out = await run('pm2', ['jlist']);
  if (!out) return [];
  let list;
  try { list = JSON.parse(out); } catch { return []; }
  return list.map((p) => ({
    name: p.name,
    pid: p.pid,
    status: p.pm2_env && p.pm2_env.status,
    restarts: p.pm2_env && p.pm2_env.restart_time,
    unstableRestarts: p.pm2_env && p.pm2_env.unstable_restarts,
    uptimeMs: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
    cpu: p.monit && p.monit.cpu,
    memoryBytes: p.monit && p.monit.memory,
  }));
}

// nginx: parse sites-enabled for server_name + proxy_pass (the routing map),
// and check each site's TLS cert expiry. Best-effort text parsing for v1.
async function nginx(sitesDir) {
  const result = { sites: [] };
  let files = [];
  try { files = fs.readdirSync(sitesDir); } catch { return result; }

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(sitesDir, f), 'utf8'); } catch { continue; }
    const serverNames = [...text.matchAll(/server_name\s+([^;]+);/g)]
      .flatMap((m) => m[1].trim().split(/\s+/)).filter((n) => n && n !== '_');
    const upstreams = [...text.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1].trim());
    const certMatch = text.match(/ssl_certificate\s+([^;]+);/);
    let certExpiry = null;
    if (certMatch) certExpiry = await certExpiryDays(certMatch[1].trim());

    if (serverNames.length || upstreams.length) {
      result.sites.push({ file: f, serverNames, upstreams, certExpiryDays: certExpiry });
    }
  }
  return result;
}

async function certExpiryDays(certPath) {
  const out = await run('openssl', ['x509', '-enddate', '-noout', '-in', certPath]);
  if (!out) return null;
  const m = out.match(/notAfter=(.+)/);
  if (!m) return null;
  const end = new Date(m[1].trim()).getTime();
  if (Number.isNaN(end)) return null;
  return Math.round((end - Date.now()) / (24 * 60 * 60 * 1000));
}

// Static-ish specs for the "interface specs" screen.
function specs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (!a.internal && a.family === 'IPv4') ips.push({ iface: name, ip: a.address });
    }
  }
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: (os.cpus()[0] || {}).model || 'unknown',
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    uptimeSeconds: os.uptime(),
    loadavg: os.loadavg(),
    ips,
  };
}

async function collect(opts) {
  const [cpu, dsk, procs, ng] = await Promise.all([
    cpuPercent(1000),
    disks(),
    pm2(),
    nginx(opts.nginxSitesDir),
  ]);
  const mem = memory();
  return {
    server: opts.serverName,
    cpuPercent: cpu,
    memPercent: mem.usedPercent,
    memory: mem,
    disks: dsk,
    pm2: procs,
    nginx: ng,
    specs: specs(),
  };
}

module.exports = { collect, specs };
