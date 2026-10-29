import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { go } from '../router.js';
import { fmtBytes, fmtUptime } from '../format.js';
import AlertBanner from '../components/AlertBanner.jsx';
import StatTile from '../components/StatTile.jsx';
import AreaChart from '../components/AreaChart.jsx';
import StoragePanel from '../components/StoragePanel.jsx';


function pm2StatusClass(s) {
  s = (s || '').toLowerCase();
  if (s === 'online') return 'status-live';
  if (s === 'stopped' || s === 'errored') return 'status-bounty';
  return 'status-planned';
}

function mainDisk(server) {
  const d = server.disks || [];
  if (!d.length) return null;
  return d.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a), d[0]);
}

const RANGES = [['1h', 'last hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];

export default function Dashboard() {
  const [server, setServer] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [hist, setHist] = useState(null);
  const [range, setRange] = useState('1h');
  const [live, setLive] = useState(true);
  const [up, setUp] = useState(null);
  const [error, setError] = useState('');

  // Live: tiles every 5 s; the 1 h chart with them, longer ranges every minute.
  // Paused: nothing refreshes, so a spike can be inspected without it scrolling away.
  useEffect(() => {
    let alive = true;
    let ticks = 0;
    async function refresh() {
      const withHist = ticks++ % (range === '1h' ? 1 : 12) === 0;
      try {
        const [m, h, u] = await Promise.all([
          api.metrics(), withHist ? api.history(range) : null, api.uptimeSummary().catch(() => null),
        ]);
        if (!alive) return;
        setServer(m.server);
        setAlerts(m.alerts || []);
        if (h) setHist(h);
        setUp(u);
        setError('');
      } catch (e) {
        if (alive && e.message !== 'unauthorized') setError('Could not reach the monitor.');
      }
    }
    refresh();
    if (!live) return () => { alive = false; };
    const id = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [range, live]);

  if (!server) {
    return (<><Header active="/" /><main className="wrap"><div className="panel">{error || 'Collecting first sample…'}</div></main></>);
  }

  const specs = server.specs || {};
  const disk = mainDisk(server);
  const procs = server.pm2 || [];
  const online = procs.filter((p) => (p.status || '').toLowerCase() === 'online').length;
  const sites = (server.nginx && server.nginx.sites) || [];
  const points = hist?.points || [];
  const cpuSeries = points.map((r) => ({ ts: r.ts, v: r.cpu, p: r.cpuMax }));
  const memSeries = points.map((r) => ({ ts: r.ts, v: r.mem, p: r.memMax }));
  const diskSeries = points.map((r) => ({ ts: r.ts, v: r.disk }));
  const rangeLabel = RANGES.find(([k]) => k === range)[1];
  const chartProps = { stepMs: hist?.stepMs, from: hist?.from, to: hist?.to };

  return (
    <>
      <Header active="/" live sub={server.specs?.hostname || server.server} />
      <main className="wrap">
        <AlertBanner alerts={alerts} />
        {error && <div className="panel panel-danger">{error}</div>}

        <section className="tiles">
          <StatTile label="CPU" value={(server.cpuPercent ?? 0).toFixed(0)} unit="%" pct={server.cpuPercent}
            sub={`${specs.cpuCount || '?'} cores · load ${(specs.loadavg || [0])[0].toFixed(2)}`} />
          <StatTile label="Memory" value={(server.memPercent ?? 0).toFixed(0)} unit="%" pct={server.memPercent}
            sub={`${fmtBytes(server.memory?.usedBytes)} / ${fmtBytes(server.memory?.totalBytes)}`} />
          <StatTile label="Disk" value={disk ? disk.usedPercent.toFixed(0) : '—'} unit={disk ? '%' : ''} pct={disk?.usedPercent}
            sub={disk ? `${disk.mount} · ${fmtBytes(disk.totalBytes - disk.usedBytes)} free` : 'no mount'} />
          <StatTile label="Uptime" value={fmtUptime(specs.uptimeSeconds)}
            sub={specs.platform || ''} />
          <StatTile label="Apps" value={online} unit={` / ${procs.length}`}
            sub="pm2 online" />
          <a className="tile-link" href="/uptime" onClick={go('/uptime')}>
            {up && up.total ? (
              <StatTile label="Sites up" value={up.up} unit={` / ${up.total}`}
                sub={up.down.length ? `down: ${up.down.join(', ')}` : up.soonestCert ? `next cert in ${up.soonestCert.days} d` : 'all answering'} />
            ) : <StatTile label="Sites" value={sites.length} sub="nginx server blocks" />}
          </a>
        </section>

        <div className="filters chart-controls">
          <div className="seg" role="group" aria-label="Chart range">
            {RANGES.map(([k, label]) => (
              <button key={k} type="button" className={range === k ? 'on' : ''} onClick={() => { setHist(null); setRange(k); }}>{label}</button>
            ))}
          </div>
          <button type="button" className={`secondary small live-toggle ${live ? 'is-live' : ''}`} onClick={() => setLive((v) => !v)} aria-pressed={!live}>
            {live ? <><span className="live-dot" /> Live</> : '❚❚ Paused — resume'}
          </button>
          <span className="muted h2-sub">{range === '1h' ? '10 s samples' : `1 point = ${Math.round((hist?.stepMs || 60000) / 60000)} min · dashed = peak`}</span>
        </div>
        <section className="charts">
          <div className="panel chart-panel"><AreaChart data={cpuSeries} color="var(--petrol-bright)" title={`CPU — ${rangeLabel}`} now={server.cpuPercent} {...chartProps} /></div>
          <div className="panel chart-panel"><AreaChart data={memSeries} color="var(--blue)" title={`Memory — ${rangeLabel}`} now={server.memPercent} {...chartProps} /></div>
          <div className="panel chart-panel"><AreaChart data={diskSeries} color="var(--petrol-bright)" title={`Disk ${disk ? disk.mount : ''} — ${rangeLabel}`} now={disk?.usedPercent} {...chartProps} /></div>
        </section>

        <StoragePanel disks={server.disks} />

        <section className="panel">
          <h2>Apps <span className="muted h2-sub">pm2</span></h2>
          <div className="table-scroll"><table className="t">
            <thead><tr><th>Name</th><th>Status</th><th className="num">CPU</th><th className="num">Mem</th><th className="num">Uptime</th><th className="num">↺</th></tr></thead>
            <tbody>
              {procs.length ? procs.map((p) => (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td><span className={`status ${pm2StatusClass(p.status)}`}>{p.status || 'unknown'}</span></td>
                  <td className="num">{p.cpu ?? '—'}%</td>
                  <td className="num">{fmtBytes(p.memoryBytes)}</td>
                  <td className="num">{fmtUptime(p.uptimeMs ? p.uptimeMs / 1000 : null)}</td>
                  <td className="num">{p.restarts ?? '—'}</td>
                </tr>
              )) : <tr><td colSpan={6} className="muted">No pm2 processes.</td></tr>}
            </tbody>
          </table></div>
        </section>

        <section className="panel">
          <h2>nginx <span className="muted h2-sub">sites</span></h2>
          <div className="table-scroll"><table className="t">
            <thead><tr><th>Server name</th><th>Upstream</th><th className="num">TLS</th></tr></thead>
            <tbody>
              {sites.length ? sites.map((s, i) => {
                const days = s.certExpiryDays;
                let tls = null;
                if (days !== null && days !== undefined) {
                  const cls = days < 0 ? 'expired' : days < 14 ? 'soon' : '';
                  tls = <span className={`expiry ${cls}`}>{days < 0 ? 'EXPIRED' : `${days}d`}</span>;
                }
                return (
                  <tr key={i}>
                    <td className="mono">{s.serverNames.join(', ') || s.file}</td>
                    <td className="muted">{(s.upstreams || []).join(', ') || '—'}</td>
                    <td className="num">{tls}</td>
                  </tr>
                );
              }) : <tr><td colSpan={3} className="muted">No nginx sites found.</td></tr>}
            </tbody>
          </table></div>
        </section>

        <section className="panel specs">
          <h2>Server specs</h2>
          <div className="spec-grid">
            <div><span className="spec-k">Hostname</span><span className="mono">{specs.hostname}</span></div>
            <div><span className="spec-k">Platform</span><span>{specs.platform}</span></div>
            <div><span className="spec-k">CPU</span><span>{specs.cpuCount} × {specs.cpuModel}</span></div>
            <div><span className="spec-k">Memory</span><span>{fmtBytes(specs.totalMemBytes)}</span></div>
            <div><span className="spec-k">Arch</span><span>{specs.arch}</span></div>
            <div><span className="spec-k">Load avg</span><span className="mono">{(specs.loadavg || []).map((n) => n.toFixed(2)).join('  ')}</span></div>
            <div><span className="spec-k">IP</span><span className="mono">{(specs.ips || []).map((i) => i.ip).join(', ') || '—'}</span></div>
            <div><span className="spec-k">Uptime</span><span>{fmtUptime(specs.uptimeSeconds)}</span></div>
          </div>
        </section>
      </main>
    </>
  );
}
