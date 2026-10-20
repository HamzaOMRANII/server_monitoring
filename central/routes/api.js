'use strict';

// Read + settings API for the dashboard. All routes here sit behind the login
// gate (mounted with requireAuth in server.js). v1 is read-only except for the
// settings update — there are no state-changing actions on monitored boxes yet.

const express = require('express');
const store = require('../store');
const alerts = require('../alerts');
const settings = require('../settings');

function create() {
  const router = express.Router();

  // Overview: latest snapshot per server + currently firing alerts.
  router.get('/overview', (req, res) => {
    res.json({
      servers: store.allLatest(),
      alerts: alerts.activeAlerts(),
    });
  });

  // One server's latest snapshot (apps, nginx, disks, specs...).
  router.get('/server/:name', (req, res) => {
    const latest = store.latest(req.params.name);
    if (!latest) return res.status(404).json({ error: 'unknown server' });
    res.json(latest);
  });

  // History for charts. ?minutes=60
  router.get('/server/:name/history', (req, res) => {
    const minutes = Math.min(Number(req.query.minutes) || 60, 180);
    const rows = store.history(req.params.name, minutes * 60 * 1000).map((s) => ({
      ts: s.ts, cpuPercent: s.cpuPercent, memPercent: s.memPercent,
    }));
    res.json(rows);
  });

  // Settings (redacted) + update.
  router.get('/settings', (req, res) => res.json(settings.publicView()));
  router.put('/settings', (req, res) => {
    settings.update(req.body || {});
    res.json(settings.publicView());
  });

  return router;
}

module.exports = { create };
