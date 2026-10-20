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

async function execute(id, arg) {
  const action = ACTIONS[id];
  if (!action) return { ok: false, error: 'unknown action' };

  if (action.needs === 'process') {
    if (!(await validProcess(arg))) {
      audit(`DENY ${id} arg=${JSON.stringify(arg)} (invalid/unknown process)`);
      return { ok: false, error: 'invalid or unknown pm2 process' };
    }
  }

  const [cmd, args] = action.build(arg);
  audit(`RUN  ${id} ${args.join(' ')}`);
  const res = await run(cmd, args);
  audit(`DONE ${id} code=${res.code}`);
  return {
    ok: res.ok,
    code: res.code,
    output: (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).trim().slice(0, 8000),
  };
}

module.exports = { list, execute };
