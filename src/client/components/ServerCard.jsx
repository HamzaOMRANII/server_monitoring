import Meter from './Meter.jsx';

const U = ['B', 'KB', 'MB', 'GB', 'TB'];
function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  let i = 0;
  while (n >= 1024 && i < U.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${U[i]}`;
}
function fmtUptime(s) {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function pm2StatusClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'online') return 'status-live';
  if (s === 'stopped' || s === 'errored') return 'status-bounty';
  return 'status-planned';
}

export default function ServerCard({ snapshot: s }) {
  const specs = s.specs || {};
  const disks = s.disks || [];
  const procs = s.pm2 || [];
  const sites = (s.nginx && s.nginx.sites) || [];

  return (
    <section className="card card-static srv">
      <div className="srv-head">
        <div>
          <div className="card-name">{s.server}</div>
          <div className="card-meta">
            {specs.hostname} · {specs.platform} · {(specs.ips || []).map((i) => i.ip).join(', ') || 'no IP'}
          </div>
        </div>
        <span className="muted srv-age">{new Date(s.ts).toLocaleTimeString()}</span>
      </div>

      <div className="meters">
        <Meter label="CPU" pct={s.cpuPercent} />
        <Meter label="RAM" pct={s.memPercent} detail={fmtBytes(s.memory && s.memory.usedBytes)} />
      </div>

      <div className="srv-section">Disks</div>
      <table className="t">
        <tbody>
          {disks.length ? disks.map((d) => (
            <tr key={d.mount}>
              <td>{d.mount}</td>
              <td className="num">{d.usedPercent.toFixed(0)}%</td>
              <td className="num muted">{fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)}</td>
            </tr>
          )) : <tr><td className="muted">—</td></tr>}
        </tbody>
      </table>

      <div className="srv-section">Apps (pm2)</div>
      <table className="t">
        <thead><tr><th>Name</th><th>Status</th><th className="num">CPU</th><th className="num">Mem</th><th className="num">Restarts</th></tr></thead>
        <tbody>
          {procs.length ? procs.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td><span className={`status ${pm2StatusClass(p.status)}`}>{p.status || 'unknown'}</span></td>
              <td className="num">{p.cpu ?? '—'}%</td>
              <td className="num">{fmtBytes(p.memoryBytes)}</td>
              <td className="num">{p.restarts ?? '—'}</td>
            </tr>
          )) : <tr><td colSpan={5} className="muted">No pm2 processes reported.</td></tr>}
        </tbody>
      </table>

      <div className="srv-section">nginx sites</div>
      <table className="t">
        <thead><tr><th>Server name</th><th>Upstream</th><th className="num">TLS</th></tr></thead>
        <tbody>
          {sites.length ? sites.map((site, i) => {
            const days = site.certExpiryDays;
            let tls = null;
            if (days !== null && days !== undefined) {
              const cls = days < 0 ? 'expired' : days < 14 ? 'soon' : '';
              tls = <span className={`expiry ${cls}`}>{days < 0 ? 'EXPIRED' : `${days}d`}</span>;
            }
            return (
              <tr key={i}>
                <td>{site.serverNames.join(', ') || site.file}</td>
                <td className="muted">{(site.upstreams || []).join(', ') || '—'}</td>
                <td className="num">{tls}</td>
              </tr>
            );
          }) : <tr><td colSpan={3} className="muted">No nginx sites found.</td></tr>}
        </tbody>
      </table>

      <div className="srv-section">Specs</div>
      <table className="t">
        <tbody>
          <tr><td>CPU</td><td>{specs.cpuCount || '?'} × {specs.cpuModel || '—'}</td></tr>
          <tr><td>Memory</td><td>{fmtBytes(specs.totalMemBytes)}</td></tr>
          <tr><td>Uptime</td><td>{fmtUptime(specs.uptimeSeconds)}</td></tr>
          <tr><td>Load avg</td><td className="muted">{(specs.loadavg || []).map((n) => n.toFixed(2)).join('  ')}</td></tr>
        </tbody>
      </table>
    </section>
  );
}
