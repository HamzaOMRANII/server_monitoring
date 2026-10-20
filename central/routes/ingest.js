'use strict';

// Agent → central ingest endpoint. Authenticated with the shared INGEST_TOKEN
// (Bearer header), NOT the UI login session — agents are machines, not users.

const express = require('express');
const store = require('../store');
const alerts = require('../alerts');
const settings = require('../settings');

function create(cfg) {
  const router = express.Router();
  const token = cfg.central.ingestToken;

  router.post('/ingest', async (req, res) => {
    const auth = req.headers.authorization || '';
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || supplied !== token) {
      return res.status(401).json({ error: 'bad ingest token' });
    }

    const snapshot = req.body || {};
    if (!snapshot.server) {
      return res.status(400).json({ error: 'missing server name' });
    }
    snapshot.ts = Date.now();

    store.record(snapshot);
    try {
      await alerts.process(snapshot, settings.get());
    } catch (err) {
      console.error('[ingest] alert processing failed:', err.message);
    }

    return res.json({ ok: true });
  });

  return router;
}

module.exports = { create };
