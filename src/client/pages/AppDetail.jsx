import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import StatTile from '../components/StatTile.jsx';
import AreaChart from '../components/AreaChart.jsx';
import { api } from '../api.js';
import { go } from '../router.js';
import { fmtBytes, fmtUptime, fmtDateTime } from '../format.js';

const RANGES = [['1h', 'last hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const LEVEL_WORD = { crit: 'problem', warn: 'warning', info: 'note', ok: 'ok' };

function Advice({ items }) {
  return (
    <div className="advice">
      {items.map((a, i) => (
        <div key={i} className={`advice-item lv-${a.level}`}>
          <div className="advice-head"><span className={`lv-tag lv-${a.level}`}>{LEVEL_WORD[a.level]}</span><strong>{a.title}</strong></div>
          <p>{a.detail}</p>
          {a.commands.length > 0 && (
            <div className="advice-cmds">
              {a.commands.map((c) => <CopyCmd key={c} cmd={c} />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CopyCmd({ cmd }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd.replace(/\s+#.*$/, '')); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* no clipboard */ }
  };
  return (
    <div className="cmd">
      <code>{cmd}</code>
      <button type="button" className="link-btn" onClick={copy}>{done ? 'copied' : 'copy'}</button>
    </div>
  );
}

function LogBox({ title, lines, rotated }) {
  return (
    <div className="panel">
      <h2>{title} <span className="muted h2-sub">last {lines.length} lines{rotated ? ` · includes ${rotated}` : ''}</span></h2>
      {lines.length ? <pre className="logbox">{lines.join('\n')}</pre> : <div className="muted">Empty.</div>}
    </div>
  );
}

export default function AppDetail({ name }) {
  const [range, setRange] = useState('24h');
  const [d, setD] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api.app(name, range)
      .then((x) => { if (alive) { setD(x); setError(''); } })
      .catch((e) => { if (alive && e.message !== 'unauthorized') setError(e.status === 404 ? `No pm2 app named "${name}".` : 'Could not load this app.'); });
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [name, range]);

  const back = <a className="back-link" href="/" onClick={go('/')}>← Dashboard</a>;
  if (!d) return (<><Header active="/" sub={name} /><main className="wrap">{back}<div className={`panel ${error ? 'panel-danger' : ''}`}>{error || 'Loading…'}</div></main></>);

  const a = d.app;
  const pts = d.series.points;
  const markers = d.restarts.map((r) => ({ ts: r.ts, label: `${r.count} restart(s) · ${fmtDateTime(r.ts)}` }));
  const chartProps = { stepMs: d.series.stepMs, from: d.series.from, to: d.series.to, markers };
  const mbFmt = (v, axis) => (axis ? `${Math.round(v / 1048576)}` : fmtBytes(v));
  const rangeLabel = RANGES.find(([k]) => k === range)[1];
  const statusCls = String(a.status).toLowerCase() === 'online' ? 'status-live' : 'status-bounty';

  return (
    <>
      <Header active="/" sub={a.name} />
      <main className="wrap">
        {back}
        <div className="app-title">
          <h1 className="mono">{a.name}</h1>
          <span className={`status ${statusCls}`}>{a.status}</span>
        </div>

        <section className="tiles">
          <StatTile label="CPU" value={a.cpu ?? '—'} unit={a.cpu != null ? '%' : ''} sub="now" />
          <StatTile label="Memory" value={fmtBytes(a.memoryBytes)} sub={a.processes ? `now · ${a.processes} process${a.processes > 1 ? 'es' : ''}` : 'now'} />
          <StatTile label="Uptime" value={fmtUptime(a.uptimeMs ? a.uptimeMs / 1000 : null)} sub="since last start" />
          <StatTile label="Restarts" value={a.restarts ?? '—'} sub={`${d.restarts.reduce((s, r) => s + r.count, 0)} in ${rangeLabel}`} />
        </section>

        <section className="panel">
          <h2>What to look at</h2>
          <Advice items={d.advice} />
        </section>

        <div className="filters chart-controls">
          <div className="seg" role="group" aria-label="Chart range">
            {RANGES.map(([k, label]) => (
              <button key={k} type="button" className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{label}</button>
            ))}
          </div>
          <span className="muted h2-sub">per-minute averages · dashed gold = restart</span>
        </div>
        <section className="charts">
          <div className="panel chart-panel">
            <AreaChart data={pts.map((p) => ({ ts: p.ts, v: p.cpu }))} color="var(--petrol-bright)" title={`CPU — ${rangeLabel}`} max="auto" now={a.cpu} {...chartProps} />
          </div>
          <div className="panel chart-panel">
            <AreaChart data={pts.map((p) => ({ ts: p.ts, v: p.mem }))} color="var(--blue)" title={`Memory (MB) — ${rangeLabel}`} max="auto" fmt={mbFmt} now={a.memoryBytes} {...chartProps} />
          </div>
        </section>

        <section className="panel specs specs-wide">
          <h2>Process</h2>
          <div className="spec-grid">
            <div><span className="spec-k">Folder</span><span className={`mono ${d.cwdExists === false ? 'bad-text' : ''}`}>{a.cwd || '—'}{d.cwdExists === false ? ' (missing)' : ''}</span></div>
            <div><span className="spec-k">Runs</span><span className="mono">{[a.script, a.args].filter(Boolean).join(' ') || '—'}</span></div>
            <div><span className="spec-k">PORT</span><span className="mono">{a.port ?? '—'}</span></div>
            <div><span className="spec-k">Listens on</span><span className="mono">{d.ports.join(', ') || 'nothing'}</span></div>
            <div><span className="spec-k">Sites</span><span className="mono">{d.sites.join(', ') || '—'}</span></div>
            <div><span className="spec-k">PID</span><span className="mono">{a.pid || '—'}</span></div>
            <div><span className="spec-k">Mode</span><span>{a.execMode || '—'}</span></div>
            <div><span className="spec-k">Node</span><span className="mono">{a.nodeVersion || '—'}</span></div>
          </div>
        </section>

        <LogBox title="Error log" lines={d.logs.err} rotated={d.logs.errRotated} />
        <LogBox title="Output log" lines={d.logs.out} rotated={d.logs.outRotated} />
      </main>
    </>
  );
}
