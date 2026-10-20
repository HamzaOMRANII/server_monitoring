'use strict';

// Live settings: alert rules + receivers. Seeded from config on first run,
// then persisted to data/settings.json so edits in the settings screen
// survive restarts. The alert engine and notifier read from here, not from
// config directly, so changes take effect immediately.

const fs = require('fs');
const path = require('path');
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

// Shallow-merge an update (used by the settings API). Secrets passed as empty
// strings are ignored so the UI never has to echo them back.
function update(patch) {
  if (patch.alertRules) {
    current.alertRules = mergeRules(current.alertRules, patch.alertRules);
  }
  if (patch.receivers) {
    current.receivers = mergeReceivers(current.receivers, patch.receivers);
  }
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

function mergeReceivers(base, incoming) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [channel, cfg] of Object.entries(incoming)) {
    out[channel] = out[channel] || {};
    for (const [k, v] of Object.entries(cfg)) {
      // don't overwrite a stored secret with an empty string from the form
      if ((k === 'pass' || k === 'botToken') && v === '') continue;
      if (k === 'smtp') {
        out[channel].smtp = { ...(out[channel].smtp || {}) };
        for (const [sk, sv] of Object.entries(v)) {
          if (sk === 'pass' && sv === '') continue;
          out[channel].smtp[sk] = sv;
        }
      } else {
        out[channel][k] = v;
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
  if (safe.receivers && safe.receivers.telegram) {
    safe.receivers.telegram.botToken = safe.receivers.telegram.botToken ? '••••••' : '';
  }
  return safe;
}

module.exports = { seedFrom, get, update, publicView };
