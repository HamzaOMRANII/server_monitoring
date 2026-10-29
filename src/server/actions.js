'use strict';

// Scoped actions: a FIXED, allow-listed set of operations the dashboard can run
// on this box. Unlike a raw terminal, the app can only ever do exactly what is
// listed here — each action is a named, audited operation with validated args.
//
// Every run is appended to data/actions.log with a timestamp.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ROOT } = require('./config');

const LOG = path.join(ROOT, 'data', 'actions.log');

function audit(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// The catalog. Each action declares how to build its argv from validated input.
const ACTIONS = {
  'pm2.restart': {
    label: 'Restart a pm2 app',
    needs: 'process',
    build: (name) => ['pm2', ['restart', name, '--update-env']],
  },
  'pm2.stop': {
    label: 'Stop a pm2 app',
    needs: 'process',
    build: (name) => ['pm2', ['stop', name]],
  },
  'pm2.start': {
    label: 'Start a pm2 app',
    needs: 'process',
    build: (name) => ['pm2', ['start', name]],
  },
  'pm2.flush': {
    label: 'Flush a pm2 app log',
    needs: 'process',
    build: (name) => ['pm2', ['flush', name]],
  },
  'nginx.test': {
    label: 'Test nginx config',
    needs: 'none',
    build: () => ['nginx', ['-t']],
  },
  'nginx.reload': {
    label: 'Reload nginx',
    needs: 'none',
    // test first; reload only if the config is valid
    build: () => ['sh', ['-c', 'nginx -t && (systemctl reload nginx || nginx -s reload)']],
  },
};

function list() {
  return Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, needs: a.needs }));
}

// A pm2 process name must match a currently-running process and be a safe token.
async function validProcess(name) {
  if (typeof name !== 'string' || !/^[\w.@-]{1,64}$/.test(name)) return false;
  const res = await run('pm2', ['jlist'], 8000);
  if (!res.ok) return false;
  try {
    return JSON.parse(res.stdout).some((p) => p.name === name);
  } catch {
    return false;
  }
}

// The monitor runs as pm2 app SELF: stopping it would take this page down, and a
// restart would kill the request before it answers, so restart is deferred.
const SELF = process.env.name || process.env.pm_name || 'monitoring';

async function execute(id, arg, { ip = '?' } = {}) {
  const action = ACTIONS[id];
  if (!action) return { ok: false, error: 'unknown action' };
  const who = `ip=${ip}`;

  if (action.needs === 'process') {
    if (!(await validProcess(arg))) {
      audit(`DENY ${id} arg=${JSON.stringify(arg)} (invalid/unknown process) ${who}`);
      return { ok: false, error: 'invalid or unknown pm2 process' };
    }
    if (arg === SELF && id === 'pm2.stop') {
      audit(`DENY ${id} ${arg} (would stop this dashboard) ${who}`);
      return { ok: false, error: `"${SELF}" is this dashboard: stopping it from here would lock you out. Use SSH: pm2 stop ${SELF}` };
    }
    if (arg === SELF && id === 'pm2.restart') {
      audit(`RUN  ${id} ${arg} (deferred 1 s: self) ${who}`);
      setTimeout(() => { run('pm2', ['restart', SELF, '--update-env']); }, 1000).unref?.();
      return { ok: true, code: 0, output: `Restarting "${SELF}" (this dashboard) in 1 s — the page reconnects by itself.` };
    }
  }

  const [cmd, args] = action.build(arg);
  audit(`RUN  ${id} ${args.join(' ')} ${who}`);
  const res = await run(cmd, args);
  audit(`DONE ${id} code=${res.code} ${who}`);
  return {
    ok: res.ok,
    code: res.code,
    output: (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).trim().slice(0, 8000),
  };
}

// Last `n` audit lines, newest first (read-only, for the console page).
function recent(n = 60) {
  try {
    const st = fs.statSync(LOG);
    const start = Math.max(0, st.size - 64 * 1024);
    const fd = fs.openSync(LOG, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-n).reverse();
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

module.exports = { list, execute, recent };
