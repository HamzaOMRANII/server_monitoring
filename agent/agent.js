'use strict';

// The agent: samples the local box every N seconds and POSTs a snapshot to
// central. Runs under pm2 on each monitored server. Config comes from
// config.json's "agent" block, overridable by env (handy under pm2).

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { load } = require('../src/server/config');
const collectors = require('./collectors');

const cfg = load();
const a = cfg.agent || {};

const options = {
  serverName: process.env.SERVER_NAME || a.serverName || require('os').hostname(),
  centralUrl: process.env.CENTRAL_URL || a.centralUrl || 'http://localhost:8080',
  ingestToken: process.env.INGEST_TOKEN || a.ingestToken || '',
  sampleSeconds: Number(process.env.SAMPLE_SECONDS || a.sampleSeconds || 10),
  nginxSitesDir: process.env.NGINX_SITES_DIR || a.nginxSitesDir || '/etc/nginx/sites-enabled',
};

function post(snapshot) {
  return new Promise((resolve) => {
    const url = new URL('/api/ingest', options.centralUrl);
    const body = JSON.stringify(snapshot);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${options.ingestToken}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', (err) => {
      console.error('[agent] post failed:', err.message);
      resolve(0);
    });
    req.write(body);
    req.end();
  });
}

async function tick() {
  try {
    const snapshot = await collectors.collect(options);
    const code = await post(snapshot);
    if (code === 200) {
      console.log(`[agent] reported (cpu ${snapshot.cpuPercent.toFixed(0)}% mem ${snapshot.memPercent.toFixed(0)}%)`);
    } else if (code === 401) {
      console.error('[agent] 401 — ingest token rejected by central.');
    } else if (code) {
      console.error(`[agent] central returned ${code}`);
    }
  } catch (err) {
    console.error('[agent] tick error:', err.message);
  }
}

console.log(`[agent] "${options.serverName}" → ${options.centralUrl} every ${options.sampleSeconds}s`);
tick();
setInterval(tick, options.sampleSeconds * 1000);
