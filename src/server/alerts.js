'use strict';

// The alert engine — the heart of the product.
//
// For each snapshot that arrives, every enabled rule is evaluated against the
// metric it watches. Each (server, rule, target) tuple has a small state
// machine:
//
//   OK ──(value crosses threshold)──▶ FIRING   → notify once
//   FIRING ──(still over, remindMinutes elapsed)──▶ re-notify
//   FIRING ──(value back under threshold)──▶ OK  → notify "recovered"
//
// State is in memory; every episode is also written to the alert history
// (SQLite, see history.js) and open episodes are resumed after a restart.
// The dashboard reads `activeAlerts()`.

const { notify } = require('./notifier');
const history = require('./history');

const state = new Map(); // key -> { state, since, lastNotified, detail, eventId, restored }

// History must never stop an alert from going out.
function record(fn, ...args) {
  try { return fn(...args); } catch (err) { console.error('[alerts] history write failed:', err.message); return null; }
}

const keyFor = (server, rule, target) => `${server}::${rule}::${target || '-'}`;
const now = () => Date.now();

// `subjects` ({ fire, still, recover }) overrides the default email subjects.
async function evaluate({ server, rule, target, value, threshold, remindMinutes, settings, describe, subjects = {} }) {
  const key = keyFor(server, rule, target);
  const prev = state.get(key) || { state: 'OK', since: null, lastNotified: 0 };
  const over = value >= threshold;

  if (over && prev.state === 'OK') {
    const detail = describe(value);
    const eventId = record(history.opened, { server, rule, target, since: now(), detail });
    state.set(key, { state: 'FIRING', since: now(), lastNotified: now(), detail, eventId });
    await notify(settings.receivers, {
      subject: subjects.fire || `🔴 ${server}: ${rule}${target ? ` (${target})` : ''} over threshold`,
      text: `${describe(value)} — threshold ${threshold}.`,
    });
    return;
  }

  if (over && prev.state === 'FIRING') {
    prev.restored = false;
    const remindMs = (remindMinutes || 15) * 60 * 1000;
    if (now() - prev.lastNotified >= remindMs) {
      prev.lastNotified = now();
      prev.detail = describe(value);
      state.set(key, prev);
      record(history.reminded, prev.eventId, prev.detail);
      await notify(settings.receivers, {
        subject: subjects.still || `🔴 (still) ${server}: ${rule}${target ? ` (${target})` : ''} over threshold`,
        text: `${describe(value)} — threshold ${threshold}. Firing since ${new Date(prev.since).toISOString()}.`,
      });
    }
    return;
  }

  if (!over && prev.state === 'FIRING') {
    state.set(key, { state: 'OK', since: now(), lastNotified: 0, detail: null });
    record(history.closed, prev.eventId, 'recovered', describe(value));
    await notify(settings.receivers, {
      subject: subjects.recover || `🟢 ${server}: ${rule}${target ? ` (${target})` : ''} recovered`,
      text: `${describe(value)} — back under threshold ${threshold}.`,
    });
  }
}

async function process(snapshot, settings) {
  const rules = settings.alertRules || {};
  const server = snapshot.server || 'unknown';

  if (rules.cpuPercent?.enabled && typeof snapshot.cpuPercent === 'number') {
    await evaluate({
      server, rule: 'cpuPercent', target: null,
      value: snapshot.cpuPercent, threshold: rules.cpuPercent.threshold,
      remindMinutes: rules.cpuPercent.remindMinutes, settings,
      describe: (v) => `CPU at ${v.toFixed(1)}%`,
    });
  }

  if (rules.memPercent?.enabled && typeof snapshot.memPercent === 'number') {
    await evaluate({
      server, rule: 'memPercent', target: null,
      value: snapshot.memPercent, threshold: rules.memPercent.threshold,
      remindMinutes: rules.memPercent.remindMinutes, settings,
      describe: (v) => `RAM at ${v.toFixed(1)}%`,
    });
  }

  if (rules.diskPercent?.enabled && Array.isArray(snapshot.disks)) {
    for (const disk of snapshot.disks) {
      await evaluate({
        server, rule: 'diskPercent', target: disk.mount,
        value: disk.usedPercent, threshold: rules.diskPercent.threshold,
        remindMinutes: rules.diskPercent.remindMinutes, settings,
        describe: (v) => `Disk ${disk.mount} at ${v.toFixed(1)}%`,
      });
    }
  }

  if (rules.pm2Restart?.enabled && Array.isArray(snapshot.pm2)) {
    for (const proc of snapshot.pm2) {
      await evaluate({
        server, rule: 'pm2Restart', target: proc.name,
        value: proc.unstableRestarts || 0, threshold: 3,
        remindMinutes: 30, settings,
        describe: (v) => `pm2 "${proc.name}" unstable restarts: ${v}`,
      });
    }
  }
}

// Forget a (rule, target) on every server, without notifying: used when a target is ignored.
function clear(rule, target) {
  for (const key of state.keys()) {
    const [, r, t] = key.split('::');
    if (r === rule && t === (target || '-')) {
      const v = state.get(key);
      if (v && v.state === 'FIRING') record(history.closed, v.eventId, 'cleared', null);
      state.delete(key);
    }
  }
}

// After a restart: put episodes that were firing back into the state machine,
// without emailing again. If one is not evaluated again within `graceMs` (its
// rule was disabled or its target is gone), it is closed as 'cleared'.
function resume(graceMs = 10 * 60 * 1000) {
  const open = record(history.openEpisodes) || [];
  for (const e of open) {
    state.set(keyFor(e.server, e.rule, e.target), {
      state: 'FIRING', since: e.started_at, lastNotified: now(), detail: e.last_detail, eventId: e.id, restored: true,
    });
  }
  if (open.length) console.log(`[alerts] resumed ${open.length} firing alert(s) from history`);
  const t = setTimeout(() => {
    for (const [key, v] of state) {
      if (v.state === 'FIRING' && v.restored) {
        record(history.closed, v.eventId, 'cleared', null);
        state.delete(key);
      }
    }
  }, graceMs);
  t.unref?.();
  const daily = setInterval(() => record(history.prune), 24 * 60 * 60 * 1000);
  daily.unref?.();
  record(history.prune);
}

function activeAlerts() {
  const active = [];
  for (const [key, v] of state.entries()) {
    if (v.state === 'FIRING') {
      const [server, rule, target] = key.split('::');
      active.push({ server, rule, target: target === '-' ? null : target, since: v.since, detail: v.detail });
    }
  }
  return active;
}

module.exports = { process, evaluate, clear, resume, activeAlerts };
