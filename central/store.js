'use strict';

// In-memory store of recent snapshots, keyed by server name. A ring buffer per
// server keeps roughly the last window of samples so the dashboard can draw
// "last hour" without a database. v1 is memory-only on purpose; the roadmap
// swaps this for SQLite without changing callers.

const MAX_SAMPLES = 720; // e.g. 2h at one sample / 10s

const servers = new Map(); // name -> { latest, history: [snapshot...] }

function record(snapshot) {
  const name = snapshot.server || 'unknown';
  if (!servers.has(name)) {
    servers.set(name, { history: [] });
  }
  const entry = servers.get(name);
  entry.latest = snapshot;
  entry.history.push(snapshot);
  if (entry.history.length > MAX_SAMPLES) {
    entry.history.splice(0, entry.history.length - MAX_SAMPLES);
  }
  return entry;
}

function listServers() {
  return [...servers.keys()];
}

function latest(name) {
  const entry = servers.get(name);
  return entry ? entry.latest : null;
}

function allLatest() {
  return [...servers.values()].map((e) => e.latest).filter(Boolean);
}

// history since `sinceMs` ago (default 1h), optionally downsampled.
function history(name, sinceMs = 60 * 60 * 1000) {
  const entry = servers.get(name);
  if (!entry) return [];
  const cutoff = Date.now() - sinceMs;
  return entry.history.filter((s) => s.ts >= cutoff);
}

module.exports = { record, listServers, latest, allLatest, history };
