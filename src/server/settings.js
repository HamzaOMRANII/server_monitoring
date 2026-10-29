'use strict';

// Live settings: alert rules + the email receiver. Seeded from config on first
// run, then persisted to data/settings.json so edits in the settings screen
// survive restarts. The alert engine and notifier read from here, not from
// config directly, so changes take effect immediately.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config');

const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

let current = null;

function seedFrom(cfg) {
  if (fs.existsSync(FILE)) {
    current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } else {
    current = {
      alertRules: cfg.alertRules || {},
      receivers: cfg.receivers || {},
    };
    persist();
  }
  return current;
}

function persist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
}

function get() {
  return current;
}

function update(patch) {
  if (patch.alertRules) current.alertRules = mergeRules(current.alertRules, patch.alertRules);
  if (patch.receivers) current.receivers = mergeReceivers(current.receivers, patch.receivers);
  if (patch.uptime) current.uptime = cleanUptime({ ...(current.uptime || {}), ...patch.uptime });
  persist();
  return current;
}

function mergeRules(base, incoming) {
  const out = { ...base };
  for (const [name, rule] of Object.entries(incoming)) {
    out[name] = { ...(out[name] || {}), ...rule };
  }
  return out;
}

// Only the email channel in v1. A blank smtp password from the form means
// "keep the stored one" so the UI never has to echo the secret back.
function mergeReceivers(base, incoming) {
  const out = JSON.parse(JSON.stringify(base || {}));
  const email = incoming.email;
  if (email) {
    out.email = out.email || {};
    for (const [k, v] of Object.entries(email)) {
      if (k === 'smtp') {
        out.email.smtp = { ...(out.email.smtp || {}) };
        for (const [sk, sv] of Object.entries(v)) {
          if (sk === 'pass' && sv === '') continue;
          out.email.smtp[sk] = sv;
        }
      } else {
        out.email[k] = v;
      }
    }
  }
  return out;
}

// Uptime check options: numbers clamped, lists trimmed and de-duplicated.
function cleanUptime(u) {
  const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
  const num = (v, min, max, dflt) => Math.min(max, Math.max(min, Number(v) || dflt));
  return {
    intervalSeconds: num(u.intervalSeconds, 30, 3600, 60),
    timeoutSeconds: num(u.timeoutSeconds, 2, 30, 10),
    ignore: list(u.ignore).map((x) => x.toLowerCase()),
    extraUrls: list(u.extraUrls).filter((x) => /^https?:\/\//i.test(x)),
    tlsEndpoints: list(u.tlsEndpoints).filter((x) => /^[a-z0-9.-]+:\d{1,5}$/i.test(x)),
  };
}

// Redacted copy safe to send to the browser (no secrets).
function publicView() {
  const safe = JSON.parse(JSON.stringify(current));
  if (safe.receivers && safe.receivers.email && safe.receivers.email.smtp) {
    safe.receivers.email.smtp.pass = safe.receivers.email.smtp.pass ? '••••••' : '';
  }
  return safe;
}

module.exports = { seedFrom, get, update, publicView };
