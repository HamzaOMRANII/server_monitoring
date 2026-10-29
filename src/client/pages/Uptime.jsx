import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { fmtTime } from '../format.js';
import StatTile from '../components/StatTile.jsx';


// Status always carries a word, never colour alone.
function State({ t }) {
  if (t.ignored) return <span className="status status-planned">ignored</span>;
  if (t.up === null) return <span className="status status-planned">pending</span>;
  return t.up ? <span className="status status-live">up</span> : <span className="status status-bounty">down</span>;
}

function Check({ c, empty = '—' }) {
  if (!c) return <span className="muted">{empty}</span>;
  return (
    <span className={c.up ? '' : 'bad-text'} title={c.location ? `→ ${c.location}` : undefined}>
      {c.detail || (c.up ? 'ok' : c.error)}
    </span>
  );
}

function Certs({ certs, warnDays }) {
  if (!certs.length) return <span className="muted">—</span>;
  return (
    <div className="cert-list">
      {certs.map((c) => {
        const cls = c.days < 0 ? 'expired' : c.days <= warnDays ? 'soon' : '';
        return (
          <span key={c.where} className={`expiry ${cls}`} title={`${c.where}: ${c.subject || ''} · ${c.issuer || ''} · until ${c.validTo.slice(0, 10)}`}>
            {c.days < 0 ? 'EXPIRED' : `${c.days}d`} <span className="muted cert-where">{c.where === 'origin' || c.where === 'public' ? c.where : 'tls'} · {c.issuer || '?'}</span>
          </span>
        );
      })}
    </div>
  );
}

// Last 60 checks, oldest → newest; a failed check is a taller, red tick.
function Strip({ recent }) {
  if (!recent.length) return <span className="muted">—</span>;
  return (
    <span className="strip" role="img" aria-label={`${recent.filter((r) => !r.up).length} failed of the last ${recent.length} checks`}>
      {recent.map((r) => (
        <i key={r.ts} className={r.up ? 'ok' : 'fail'} title={`${fmtTime(r.ts)} · ${r.up ? 'up' : 'down'}${r.ms != null ? ` · ${r.ms} ms` : ''}`} />
      ))}
    </span>
  );
}

export default function Uptime() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => api.uptime().then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive && e.message !== 'unauthorized') setError('Could not reach the monitor.'); });
    load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  async function checkNow() {
    setBusy(true);
    try { setData(await api.uptimeCheck()); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function toggle(t) {
    setBusy(true);
    try { setData(await api.uptimeIgnore(t.name, !t.ignored)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!data) return (<><Header active="/uptime" sub="uptime" /><main className="wrap"><div className="panel">{error || 'Loading…'}</div></main></>);

  const active = data.targets.filter((t) => !t.ignored && t.up !== null);
  const down = active.filter((t) => !t.up);
  const certs = active.flatMap((t) => t.certs.map((c) => ({ ...c, name: t.name })));
  const soonest = certs.length ? certs.reduce((a, b) => (b.days < a.days ? b : a)) : null;
  const times = active.map((t) => t.public?.ms).filter((n) => typeof n === 'number');
  const avgMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const ups = active.map((t) => t.uptime24h).filter((n) => typeof n === 'number');

  return (
    <>
      <Header active="/uptime" sub="uptime" />
      <main className="wrap">
        {error && <div className="panel panel-danger">{error}</div>}
        {down.length > 0 && (
          <div className="panel panel-danger">
            <strong>{down.length} site{down.length > 1 ? 's' : ''} down:</strong> {down.map((t) => t.name).join(', ')}
          </div>
        )}

        <section className="tiles">
          <StatTile label="Sites up" value={active.length - down.length} unit={` / ${active.length}`} sub={down.length ? `${down.length} down` : 'all answering'} />
          <StatTile label="Uptime 24 h" value={ups.length ? Math.min(...ups).toFixed(1) : '—'} unit={ups.length ? '%' : ''} sub="worst site" />
          <StatTile label="Response" value={avgMs ?? '—'} unit={avgMs != null ? ' ms' : ''} sub="average, public" />
          <StatTile label="Next cert expiry" value={soonest ? soonest.days : '—'} unit={soonest ? ' d' : ''}
            sub={soonest ? `${soonest.name} · ${soonest.where}` : 'no certificates'} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Sites <span className="muted h2-sub">every {data.intervalSeconds}s · alert after {data.failuresToAlert} failed checks · certs ≤ {data.sslDays} d</span></h2>
            <div className="panel-actions">
              <span className="muted h2-sub">{data.lastRun ? `checked ${fmtTime(data.lastRun)}` : 'first check running…'}</span>
              <button type="button" className="secondary small" onClick={checkNow} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</button>
            </div>
          </div>
          <div className="table-scroll">
            <table className="t">
              <thead>
                <tr><th>Site</th><th>Status</th><th>Public</th><th>App</th><th className="num">ms</th><th className="num">24 h</th><th className="num">7 d</th><th className="num">30 d</th><th>Last 60 checks</th><th>Certificates</th><th /></tr>
              </thead>
              <tbody>
                {data.targets.length ? data.targets.map((t) => (
                  <tr key={t.id} className={t.ignored ? 'row-ignored' : t.up === false ? 'row-down' : ''}>
                    <td className="mono">{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.name}</a> : t.name}</td>
                    <td><State t={t} /></td>
                    <td><Check c={t.public} /></td>
                    <td title={t.app?.upstream || ''}><Check c={t.app} empty={t.kind === 'site' ? 'no upstream' : '—'} /></td>
                    <td className="num">{t.public?.ms ?? '—'}</td>
                    <td className="num">{t.uptime24h != null ? `${t.uptime24h}%` : '—'}</td>
                    <td className="num">{t.uptime7d != null ? `${t.uptime7d}%` : '—'}</td>
                    <td className="num">{t.uptime30d != null ? `${t.uptime30d}%` : '—'}</td>
                    <td><Strip recent={t.recent} /></td>
                    <td><Certs certs={t.certs} warnDays={data.sslDays} /></td>
                    <td className="num"><button type="button" className="link-btn" onClick={() => toggle(t)} disabled={busy}>{t.ignored ? 'Watch' : 'Ignore'}</button></td>
                  </tr>
                )) : <tr><td colSpan={11} className="muted">No sites yet: waiting for the first nginx scan.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted note">
            <strong>Public</strong> = the site through DNS/Cloudflare, like a visitor (redirects to the access gate or a login count as up).
            {' '}<strong>App</strong> = the nginx upstream on this box, checked directly, so a crashed app behind the gate is still caught.
            {' '}<strong>Certificates</strong>: <em>origin</em> = what nginx serves, <em>public</em> = what visitors see, <em>tls</em> = extra endpoints from Settings.
          </p>
        </section>
      </main>
    </>
  );
}
