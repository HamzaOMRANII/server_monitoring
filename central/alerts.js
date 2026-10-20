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
// State is in memory for v1. The dashboard reads `activeAlerts()` to show
// what's currently firing.

const { notify } = require('./notifier');

// key -> { state: 'OK'|'FIRING', since, lastNotified, detail }
const state = new Map();

function keyFor(server, rule, target) {
  return `${server}::${rule}::${target || '-'}`;
}

function nowMin() {
  return Date.now();
}

// Evaluate one metric point. Handles the transition + notification logic.
async function evaluate({ server, rule, target, value, threshold, remindMinutes, settings, describe }) {
  const key = keyFor(server, rule, target);
  const prev = state.get(key) || { state: 'OK', since: null, lastNotified: 0 };
  const over = value >= threshold;

  if (over && prev.state === 'OK') {
    // OK -> FIRING
    const entry = { state: 'FIRING', since: nowMin(), lastNotified: nowMin(), detail: describe(value) };
    state.set(key, entry);
    await notify(settings.receivers, {
      subject: `🔴 ${server}: ${rule} ${target ? `(${target}) ` : ''}over threshold`,
      text: `${describe(value)} — threshold ${threshold}.`,
    });
    return;
  }

  if (over && prev.state === 'FIRING') {
    // still firing — remind if interval elapsed
    const remindMs = (remindMinutes || 15) * 60 * 1000;
    if (nowMin() - prev.lastNotified >= remindMs) {
      prev.lastNotified = nowMin();
      prev.detail = describe(value);
      state.set(key, prev);
      await notify(settings.receivers, {
        subject: `🔴 (still) ${server}: ${rule} ${target ? `(${target}) ` : ''}over threshold`,
        text: `${describe(value)} — threshold ${threshold}. Firing since ${new Date(prev.since).toISOString()}.`,
      });
    }
    return;
  }

  if (!over && prev.state === 'FIRING') {
    // FIRING -> OK (recovered)
    state.set(key, { state: 'OK', since: nowMin(), lastNotified: 0, detail: null });
    await notify(settings.receivers, {
      subject: `🟢 ${server}: ${rule} ${target ? `(${target}) ` : ''}recovered`,
      text: `${describe(value)} — back under threshold ${threshold}.`,
    });
  }
}

// Run all enabled rules against one incoming snapshot.
async function process(snapshot, settings) {
  const rules = settings.alertRules || {};
  const server = snapshot.server || 'unknown';

  if (rules.cpuPercent && rules.cpuPercent.enabled && typeof snapshot.cpuPercent === 'number') {
    await evaluate({
      server, rule: 'cpuPercent', target: null,
      value: snapshot.cpuPercent, threshold: rules.cpuPercent.threshold,
      remindMinutes: rules.cpuPercent.remindMinutes, settings,
      describe: (v) => `CPU at ${v.toFixed(1)}%`,
    });
  }

  if (rules.memPercent && rules.memPercent.enabled && typeof snapshot.memPercent === 'number') {
    await evaluate({
      server, rule: 'memPercent', target: null,
      value: snapshot.memPercent, threshold: rules.memPercent.threshold,
      remindMinutes: rules.memPercent.remindMinutes, settings,
      describe: (v) => `RAM at ${v.toFixed(1)}%`,
    });
  }

  if (rules.diskPercent && rules.diskPercent.enabled && Array.isArray(snapshot.disks)) {
    for (const disk of snapshot.disks) {
      await evaluate({
        server, rule: 'diskPercent', target: disk.mount,
        value: disk.usedPercent, threshold: rules.diskPercent.threshold,
        remindMinutes: rules.diskPercent.remindMinutes, settings,
        describe: (v) => `Disk ${disk.mount} at ${v.toFixed(1)}%`,
      });
    }
  }

  if (rules.pm2Restart && rules.pm2Restart.enabled && Array.isArray(snapshot.pm2)) {
    for (const proc of snapshot.pm2) {
      // crude restart-loop signal: unstable restarts climbing on a running proc
      const unstable = proc.unstableRestarts || 0;
      await evaluate({
        server, rule: 'pm2Restart', target: proc.name,
        value: unstable, threshold: 3,
        remindMinutes: 30, settings,
        describe: (v) => `pm2 "${proc.name}" unstable restarts: ${v}`,
      });
    }
  }
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

module.exports = { process, activeAlerts };
