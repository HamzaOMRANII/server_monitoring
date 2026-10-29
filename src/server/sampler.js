'use strict';

// In-process sampler. This app monitors the single server it runs on: it runs
// the collectors locally on an interval, records each snapshot, and feeds the
// alert engine. There is no remote agent and no fleet — one instance per box,
// each showing only itself.

const os = require('node:os');
const collectors = require('./collectors');
const store = require('./store');
const metrics = require('./metrics');
const alerts = require('./alerts');
const settings = require('./settings');

let timer = null;

function resolveName(cfg) {
  const m = cfg.monitor || {};
  return (m.serverName && m.serverName.trim()) || os.hostname();
}

async function sampleOnce(opts) {
  try {
    const snapshot = await collectors.collect(opts);
    snapshot.ts = Date.now();
    store.record(snapshot);
    metrics.add(snapshot);
    await alerts.process(snapshot, settings.get());
    return snapshot;
  } catch (err) {
    console.error('[sampler] sample failed:', err.message);
    return null;
  }
}

function start(cfg) {
  const m = cfg.monitor || {};
  const opts = {
    serverName: resolveName(cfg),
    nginxSitesDir: m.nginxSitesDir || '/etc/nginx/sites-enabled',
  };
  const everyMs = Math.max(2, Number(m.sampleSeconds) || 10) * 1000;

  console.log(`[sampler] monitoring "${opts.serverName}" every ${everyMs / 1000}s`);
  sampleOnce(opts); // prime immediately so the dashboard isn't empty
  timer = setInterval(() => sampleOnce(opts), everyMs);
  timer.unref?.();
  return opts.serverName;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, resolveName };
