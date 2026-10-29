'use strict';

// SQLite store (node:sqlite, built into Node >= 22.5 — still zero npm deps).
// data/monitoring.db, gitignored with the rest of data/. Holds the alert history
// (M2); the metrics history (M3) will live here too. Migrations are numbered and
// run once, in order, tracked by PRAGMA user_version.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT } = require('./config');

const FILE = process.env.MONITORING_DB || path.join(ROOT, 'data', 'monitoring.db');

const MIGRATIONS = [
  // 1 — alert history: one row per alert episode (fire → recover).
  `CREATE TABLE alert_events (
     id           INTEGER PRIMARY KEY,
     server       TEXT NOT NULL,
     rule         TEXT NOT NULL,
     target       TEXT,                          -- NULL for server-wide rules (cpu, ram)
     started_at   INTEGER NOT NULL,              -- ms since epoch
     ended_at     INTEGER,                       -- NULL while firing
     end_reason   TEXT CHECK (end_reason IN ('recovered','cleared')),
     first_detail TEXT,
     last_detail  TEXT,
     reminders    INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX alert_events_started ON alert_events(started_at);
   CREATE INDEX alert_events_open ON alert_events(ended_at) WHERE ended_at IS NULL;`,

  // 2 — metrics history (M3): one row per minute (averages + peaks of the 10 s
  // samples), per pm2 app per minute, and every uptime check.
  `CREATE TABLE metric_minutes (
     minute   INTEGER PRIMARY KEY,                 -- ms since epoch, start of the minute
     cpu_avg  REAL, cpu_max REAL,
     mem_avg  REAL, mem_max REAL,
     disk     REAL,                                -- main mount, % used
     load1    REAL,
     samples  INTEGER NOT NULL
   ) WITHOUT ROWID;
   CREATE TABLE pm2_minutes (
     minute   INTEGER NOT NULL,
     name     TEXT NOT NULL,
     cpu_avg  REAL, mem_avg REAL,                  -- %, bytes
     restarts INTEGER, online INTEGER NOT NULL,    -- online = 1 if online for the whole minute
     PRIMARY KEY (name, minute)
   ) WITHOUT ROWID;
   CREATE INDEX pm2_minutes_minute ON pm2_minutes(minute);
   CREATE TABLE uptime_checks (
     target TEXT NOT NULL,
     ts     INTEGER NOT NULL,
     up     INTEGER NOT NULL,
     ms     INTEGER,
     PRIMARY KEY (target, ts)
   ) WITHOUT ROWID;
   CREATE INDEX uptime_checks_ts ON uptime_checks(ts);`,
];

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  db = new DatabaseSync(FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);
const run = (sql, ...p) => open().prepare(sql).run(...p);

module.exports = { open, all, get, run, FILE };
