'use strict';

// Central app entry point. Wires together: login gate, agent ingest endpoint,
// read/settings API, and the static dashboard.

const path = require('path');
const express = require('express');

const { load } = require('./config');
const authFactory = require('./auth');
const settings = require('./settings');
const ingestRoutes = require('./routes/ingest');
const apiRoutes = require('./routes/api');

const cfg = load();
settings.seedFrom(cfg);

const app = express();
app.use(express.json({ limit: '1mb' }));

const auth = authFactory.create(cfg);
const PUBLIC = path.join(__dirname, '..', 'public');

// --- Public (unauthenticated) endpoints ---
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

// Agent ingest: authenticated by token, not by UI session.
app.use('/api', ingestRoutes.create(cfg));

// Login page + its assets must be reachable before auth.
app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(PUBLIC, 'styles.css')));

// --- Everything below requires a session ---
app.use('/api', auth.requireAuth, apiRoutes.create());
app.use(auth.requireAuth, express.static(PUBLIC));

const port = cfg.central.port || 8080;
app.listen(port, () => {
  console.log(`[central] monitoring dashboard on http://localhost:${port}`);
  if (!cfg.central.password || cfg.central.password.startsWith('change-me')) {
    console.warn('[central] WARNING: default/empty password in config — set a real one before exposing.');
  }
});
