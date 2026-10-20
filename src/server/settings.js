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

// Redacted copy safe to send to the browser (no secrets).
function publicView() {
  const safe = JSON.parse(JSON.stringify(current));
  if (safe.receivers && safe.receivers.email && safe.receivers.email.smtp) {
    safe.receivers.email.smtp.pass = safe.receivers.email.smtp.pass ? '••••••' : '';
  }
  return safe;
}

module.exports = { seedFrom, get, update, publicView };
