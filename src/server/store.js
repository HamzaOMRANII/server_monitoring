'use strict';

// In-memory store of recent snapshots for THIS server (single-server app). A
// ring buffer keeps roughly the last window so the dashboard can draw history
// without a database. v1 is memory-only on purpose; a later version can swap
// this for SQLite without changing callers.

const MAX_SAMPLES = 1440; // ~4h at one sample / 10s

let latest = null;
const history = []; // [snapshot...]

function record(snapshot) {
  latest = snapshot;
  history.push(snapshot);
  if (history.length > MAX_SAMPLES) history.splice(0, history.length - MAX_SAMPLES);
  return snapshot;
}

function current() {
  return latest;
}

// Snapshots from the last `sinceMs` (default 60 min).
function since(sinceMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  return history.filter((s) => s.ts >= cutoff);
}

module.exports = { record, current, since };
