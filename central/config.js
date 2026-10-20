'use strict';

// Loads config.json (falling back to config.example.json so the app still
// boots for a first look). Environment variables override the most sensitive
// values so secrets don't have to live on disk in production.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function load() {
  const real = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  const file = fs.existsSync(real) ? real : example;

  if (file === example) {
    console.warn('[config] config.json not found — using config.example.json. Copy it and set real values.');
  }

  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Env overrides (preferred in production).
  cfg.central = cfg.central || {};
  if (process.env.CENTRAL_PORT) cfg.central.port = Number(process.env.CENTRAL_PORT);
  if (process.env.CENTRAL_PASSWORD) cfg.central.password = process.env.CENTRAL_PASSWORD;
  if (process.env.SESSION_SECRET) cfg.central.sessionSecret = process.env.SESSION_SECRET;
  if (process.env.INGEST_TOKEN) cfg.central.ingestToken = process.env.INGEST_TOKEN;

  return cfg;
}

module.exports = { load, ROOT };
