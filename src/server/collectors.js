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

// nginx: build the routing map (server_name -> upstream) + TLS cert expiry.
// Scans the usual config locations — nginx.conf, conf.d/*.conf and
// sites-enabled/* — and splits each file into balanced `server { }` blocks so
// one row = one virtual host, however the configs are organised. Best-effort
// text parsing; degrades to an empty list if nginx isn't present.
async function nginx(sitesDir) {
  const result = { sites: [] };
  const files = nginxConfigFiles(sitesDir);
  if (!files.length) return result;

  const certCache = new Map();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    text = text.replace(/#[^\n]*/g, ''); // strip comments
    for (const block of serverBlocks(text)) {
      const serverNames = [...block.matchAll(/server_name\s+([^;]+);/g)]
        .flatMap((m) => m[1].trim().split(/\s+/)).filter((n) => n && n !== '_');
      const upstreams = [...block.matchAll(/proxy_pass\s+([^;]+);/g)]
        .map((m) => m[1].trim()).filter((u) => !u.includes('/__gate') && !u.includes('/gate/verify'));
      if (!serverNames.length) continue; // skip catch-all / internal blocks

      const certMatch = block.match(/ssl_certificate\s+([^;]+);/);
      let certExpiry = null;
      if (certMatch) {
        const p = certMatch[1].trim();
        if (!certCache.has(p)) certCache.set(p, await certExpiryDays(p));
        certExpiry = certCache.get(p);
      }
      result.sites.push({
        file: path.basename(file),
        serverNames,
        upstreams: [...new Set(upstreams)],
        certExpiryDays: certExpiry,
      });
    }
  }
  // de-duplicate by server_name set (same vhost seen twice)
  const seen = new Set();
  result.sites = result.sites.filter((s) => {
    const k = s.serverNames.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return result;
}

// Candidate nginx config files, in a sensible order.
function nginxConfigFiles(sitesDir) {
  const files = [];
  const push = (p) => { try { if (fs.statSync(p).isFile()) files.push(p); } catch {} };
  push('/etc/nginx/nginx.conf');
  for (const dir of ['/etc/nginx/conf.d', sitesDir]) {
    try {
      for (const f of fs.readdirSync(dir)) push(path.join(dir, f));
    } catch {}
  }
  return files;
}

// Yield the contents of each top-level `server { ... }` block via brace depth.
function serverBlocks(text) {
  const blocks = [];
  const re = /server\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    blocks.push(text.slice(start, i - 1));
  }
  return blocks;
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
