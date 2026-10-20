'use strict';

// Loads config.json (falling back to config.example.json so the app still
// boots for a first look). The most sensitive values can be overridden by the
// environment / .env, matching how it.omranisystems.com is run under pm2.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env — rely on the real environment (pm2 sets it in production)
}

function load() {
  const real = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  const file = fs.existsSync(real) ? real : example;

  if (file === example) {
    console.warn('[config] config.json not found — using config.example.json. Copy it and set real values.');
  }

  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

  cfg.central = cfg.central || {};
  cfg.monitor = cfg.monitor || {};
  if (process.env.PORT) cfg.central.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.central.host = process.env.HOST;
  if (process.env.CENTRAL_PASSWORD) cfg.central.password = process.env.CENTRAL_PASSWORD;
  if (process.env.SESSION_SECRET) cfg.central.sessionSecret = process.env.SESSION_SECRET;
  if (process.env.SERVER_NAME) cfg.monitor.serverName = process.env.SERVER_NAME;

  return cfg;
}

module.exports = { load, ROOT };
