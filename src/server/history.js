'use strict';

// Alert history (M2): every alert episode is written to SQLite when it fires,
// updated on each reminder, and closed when it recovers (or is cleared because
// its target was ignored/removed). Open episodes are reloaded at start-up so a
// restart neither forgets a firing alert nor emails it a second time.

const db = require('./db');

const KEEP_DAYS = 180;
const DAY = 24 * 60 * 60 * 1000;

function opened({ server, rule, target, since, detail }) {
  const r = db.run(`INSERT INTO alert_events (server, rule, target, started_at, first_detail, last_detail)
                    VALUES (?, ?, ?, ?, ?, ?)`, server, rule, target || null, since, detail || null, detail || null);
  return Number(r.lastInsertRowid);
}

function reminded(id, detail) {
  if (id) db.run('UPDATE alert_events SET reminders = reminders + 1, last_detail = ? WHERE id = ?', detail || null, id);
}

function closed(id, reason, detail) {
  if (!id) return;
  db.run(`UPDATE alert_events SET ended_at = ?, end_reason = ?, last_detail = COALESCE(?, last_detail)
          WHERE id = ? AND ended_at IS NULL`, Date.now(), reason, detail || null, id);
}

// Episodes still firing (for the alert engine to resume after a restart).
function openEpisodes() {
  return db.all('SELECT * FROM alert_events WHERE ended_at IS NULL ORDER BY started_at');
}

function prune() {
  db.run('DELETE FROM alert_events WHERE ended_at IS NOT NULL AND ended_at < ?', Date.now() - KEEP_DAYS * DAY);
}

// History for the UI: episodes overlapping [from, now], optional rule / text filter,
// plus summary numbers for the period.
function query({ days = 7, rule = '', q = '' } = {}) {
  const now = Date.now();
  const from = days > 0 ? now - days * DAY : 0;
  const where = ['(ended_at IS NULL OR ended_at >= ?)'];
  const params = [from];
  if (rule) { where.push('rule = ?'); params.push(rule); }
  if (q) {
    where.push("(target LIKE ? ESCAPE '\\' OR last_detail LIKE ? ESCAPE '\\' OR first_detail LIKE ? ESCAPE '\\')");
    const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  const rows = db.all(`SELECT * FROM alert_events WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT 1000`, ...params);
  const events = rows.map((r) => ({
    id: r.id, server: r.server, rule: r.rule, target: r.target,
    startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason,
    durationMs: (r.ended_at || now) - r.started_at,
    firstDetail: r.first_detail, lastDetail: r.last_detail, reminders: r.reminders,
    emails: 1 + r.reminders + (r.end_reason === 'recovered' ? 1 : 0),
  }));

  // time spent firing inside the window, per rule + target
  const byTarget = new Map();
  for (const e of events) {
    const k = `${e.rule}::${e.target || ''}`;
    const inWindow = Math.min(e.endedAt || now, now) - Math.max(e.startedAt, from);
    const cur = byTarget.get(k) || { rule: e.rule, target: e.target, count: 0, firingMs: 0 };
    cur.count++;
    cur.firingMs += Math.max(0, inWindow);
    byTarget.set(k, cur);
  }
  const recovered = events.filter((e) => e.endReason === 'recovered');
  const rules = db.all('SELECT DISTINCT rule FROM alert_events ORDER BY rule').map((r) => r.rule);
  return {
    from, to: now, days,
    stats: {
      total: events.length,
      firing: events.filter((e) => !e.endedAt).length,
      siteDownMs: [...byTarget.values()].filter((t) => t.rule === 'siteDown').reduce((s, t) => s + t.firingMs, 0),
      mttrMs: recovered.length ? Math.round(recovered.reduce((s, e) => s + e.durationMs, 0) / recovered.length) : null,
      emails: events.reduce((s, e) => s + e.emails, 0),
    },
    byTarget: [...byTarget.values()].sort((a, b) => b.firingMs - a.firingMs),
    rules,
    events,
  };
}

module.exports = { opened, reminded, closed, openEpisodes, prune, query };
