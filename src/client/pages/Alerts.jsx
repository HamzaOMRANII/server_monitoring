import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import StatTile from '../components/StatTile.jsx';
import { api } from '../api.js';
import { fmtDuration, fmtDateTime } from '../format.js';

export const RULE_LABELS = {
  cpuPercent: 'CPU', memPercent: 'RAM', diskPercent: 'Disk', pm2Restart: 'pm2 restarts',
  siteDown: 'Site down', sslExpiry: 'Certificate expiry',
  newPublicPort: 'New public port', sshBruteForce: 'SSH brute force',
};
const ruleLabel = (r) => RULE_LABELS[r] || r;
const PERIODS = [[1, '24 h'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All']];

function State({ e }) {
  if (!e.endedAt) return <span className="status status-bounty">firing</span>;
  return e.endReason === 'recovered'
    ? <span className="status status-live">recovered</span>
    : <span className="status status-planned">cleared</span>;
}

// One lane per (rule, target); each episode is a bar from start to end (still-firing
// ones run to "now" and are striped). Hover shows the episode; the table below is the
// full text view of the same data.
function Timeline({ data }) {
  const [hover, setHover] = useState(null);
  const events = data.events;
  const from = data.days > 0 ? data.from : Math.min(data.to - 3600e3, ...events.map((e) => e.startedAt));
  const span = Math.max(1, data.to - from);
  const lanes = new Map();
  for (const e of events) {
    const k = `${e.rule}::${e.target || ''}`;
    if (!lanes.has(k)) lanes.set(k, { rule: e.rule, target: e.target, events: [] });
    lanes.get(k).events.push(e);
  }
  const ticks = Array.from({ length: 6 }, (_, i) => from + (span * i) / 5);
  const tickLabel = (t) => new Date(t).toLocaleString([], span <= 2 * 86400e3
    ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' });
  const pos = (t) => `${(Math.max(0, t - from) / span) * 100}%`;

  if (!lanes.size) return <div className="muted empty-chart">No alerts in this period.</div>;
  return (
    <div className="timeline" onMouseLeave={() => setHover(null)}>
      {[...lanes.values()].map((lane) => (
        <div className="tl-row" key={`${lane.rule}${lane.target}`}>
          <div className="tl-label" title={lane.target || ''}>
            <span className="tl-rule">{ruleLabel(lane.rule)}</span>
            <span className="tl-target mono">{lane.target || 'server'}</span>
          </div>
          <div className="tl-track">
            {lane.events.map((e) => {
              const start = Math.max(e.startedAt, from);
              const end = e.endedAt || data.to;
              return (
                <span key={e.id} className={`tl-bar ${e.endedAt ? 'done' : 'open'}`}
                  style={{ left: pos(start), width: `max(4px, ${((end - start) / span) * 100}%)` }}
                  onMouseEnter={() => setHover(e)} onFocus={() => setHover(e)} tabIndex={0}
                  aria-label={`${ruleLabel(e.rule)} ${e.target || ''}: ${fmtDateTime(e.startedAt)}, ${fmtDuration(e.durationMs)}`} />
              );
            })}
          </div>
        </div>
      ))}
      <div className="tl-row tl-axis">
        <div className="tl-label" />
        <div className="tl-track">
          {ticks.map((t, i) => <span key={i} className="tl-tick" style={{ left: pos(t) }}>{tickLabel(t)}</span>)}
        </div>
      </div>
      <div className="tl-foot">
        <div className="legend">
          <span><i className="tl-key done" />recovered / cleared</span>
          <span><i className="tl-key open" />still firing</span>
        </div>
        <div className="tl-hover">
          {hover ? (
            <>
              <strong>{ruleLabel(hover.rule)}</strong>{hover.target ? ` · ${hover.target}` : ''} — {fmtDateTime(hover.startedAt)}
              {hover.endedAt ? ` → ${fmtDateTime(hover.endedAt)}` : ' → now'} ({fmtDuration(hover.durationMs)}) · {hover.lastDetail || hover.firstDetail}
            </>
          ) : <span className="muted">Hover a bar for details.</span>}
        </div>
      </div>
    </div>
  );
}

export default function Alerts() {
  const [days, setDays] = useState(7);
  const [rule, setRule] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api.alertHistory(days, rule, q)
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive && e.message !== 'unauthorized') setError('Could not load the alert history.'); });
    const t = setTimeout(load, q ? 250 : 0);
    const id = setInterval(load, 30000);
    return () => { alive = false; clearTimeout(t); clearInterval(id); };
  }, [days, rule, q]);

  const s = data?.stats;
  return (
    <>
      <Header active="/alerts" sub="alert history" />
      <main className="wrap">
        {error && <div className="panel panel-danger">{error}</div>}
        <div className="filters">
          <div className="seg" role="group" aria-label="Period">
            {PERIODS.map(([d, label]) => (
              <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{label}</button>
            ))}
          </div>
          <select value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Rule">
            <option value="">All rules</option>
            {(data?.rules || []).map((r) => <option key={r} value={r}>{ruleLabel(r)}</option>)}
          </select>
          <input type="text" placeholder="Search site, disk, app…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        {!data ? <div className="panel">Loading…</div> : (
          <>
            <section className="tiles">
              <StatTile label="Alerts" value={s.total} sub={`in ${PERIODS.find(([d]) => d === days)[1].toLowerCase()}`} />
              <StatTile label="Firing now" value={s.firing} sub={s.firing ? 'see the red bars' : 'all clear'} />
              <StatTile label="Site downtime" value={fmtDuration(s.siteDownMs)} sub="all sites, in period" />
              <StatTile label="Time to recover" value={fmtDuration(s.mttrMs)} sub="average" />
              <StatTile label="Emails" value={s.emails} sub="alerts + reminders + recovered" />
            </section>

            <section className="panel">
              <h2>Timeline</h2>
              <Timeline data={data} />
            </section>

            {data.byTarget.length > 0 && (
              <section className="panel">
                <h2>Most affected</h2>
                <div className="table-scroll">
                  <table className="t">
                    <thead><tr><th>Rule</th><th>Target</th><th className="num">Alerts</th><th className="num">Time firing</th></tr></thead>
                    <tbody>
                      {data.byTarget.slice(0, 10).map((t) => (
                        <tr key={`${t.rule}${t.target}`}>
                          <td>{ruleLabel(t.rule)}</td><td className="mono">{t.target || 'server'}</td>
                          <td className="num">{t.count}</td><td className="num">{fmtDuration(t.firingMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="panel">
              <h2>All alerts <span className="muted h2-sub">{data.events.length}{data.events.length === 1000 ? ' (latest 1000)' : ''}</span></h2>
              <div className="table-scroll">
                <table className="t">
                  <thead><tr><th>Status</th><th>Rule</th><th>Target</th><th>Started</th><th>Ended</th><th className="num">Duration</th><th>Detail</th><th className="num">Emails</th></tr></thead>
                  <tbody>
                    {data.events.length ? data.events.map((e) => (
                      <tr key={e.id} className={e.endedAt ? '' : 'row-down'}>
                        <td><State e={e} /></td>
                        <td>{ruleLabel(e.rule)}</td>
                        <td className="mono">{e.target || 'server'}</td>
                        <td className="mono">{fmtDateTime(e.startedAt)}</td>
                        <td className="mono">{e.endedAt ? fmtDateTime(e.endedAt) : '—'}</td>
                        <td className="num">{fmtDuration(e.durationMs)}</td>
                        <td className="detail-cell" title={e.firstDetail !== e.lastDetail ? `first: ${e.firstDetail}` : undefined}>{e.lastDetail || e.firstDetail}</td>
                        <td className="num">{e.emails}</td>
                      </tr>
                    )) : <tr><td colSpan={8} className="muted">No alerts in this period. History starts on {new Date(data.to).toLocaleDateString()} for this install (M2).</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
