import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import StatTile from '../components/StatTile.jsx';
import AreaChart from '../components/AreaChart.jsx';
import Advice from '../components/Advice.jsx';
import { api } from '../api.js';
import { go } from '../router.js';
import { fmtDateTime } from '../format.js';

const EXPOSURE_CLS = { internet: 'lv-crit', filtered: 'lv-info', local: 'lv-ok' };

export default function Security() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showLocal, setShowLocal] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => api.security()
      .then((x) => { if (alive) { setD(x); setError(''); } })
      .catch((e) => { if (alive && e.message !== 'unauthorized') setError('Could not load the security checks.'); });
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  async function refresh() {
    setBusy(true);
    try { setD(await api.security(true)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function markKnown(p) {
    setBusy(true);
    try { setD(await api.securityKnownPort(`${p.proto}/${p.port}`)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!d) return (<><Header active="/security" sub="security" /><main className="wrap"><div className={`panel ${error ? 'panel-danger' : ''}`}>{error || 'Reading auth.log, ports and firewall… (the first time takes a few seconds)'}</div></main></>);

  const s = d.ssh;
  const internet = [...new Set(d.ports.filter((p) => p.exposure.level === 'internet').map((p) => `${p.proto}/${p.port}`))];
  const ports = d.ports.filter((p) => showLocal || p.exposure.level !== 'local');
  const series = s.perHour.map((r) => ({ ts: r.ts, v: r.n }));
  const sshd = d.sshd || {};

  return (
    <>
      <Header active="/security" sub="security" />
      <main className="wrap">
        {error && <div className="panel panel-danger">{error}</div>}

        <section className="tiles">
          <StatTile label="Failed SSH logins" value={s.fails24h.toLocaleString()} sub={`last 24 h · ${s.failsLastHour.toLocaleString()} in ~1 h`} />
          <StatTile label="Attacking IPs" value={s.ips24h} sub="last 24 h" />
          <StatTile label="SSH logins" value={s.logins.length} sub="successful, last 30 d" />
          <StatTile label="Open to internet" value={internet.length} sub="ports (80/443 are Cloudflare-only)" />
          <StatTile label="Updates" value={d.updates ? d.updates.total : '—'} sub={d.updates ? `${d.updates.security} security${d.reboot?.required ? ' · reboot needed' : ''}` : 'checking…'} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>What to fix</h2>
            <div className="panel-actions">
              <span className="muted h2-sub">checked {fmtDateTime(d.checkedAt)} · read-only, nothing is changed</span>
              <button type="button" className="secondary small" onClick={refresh} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</button>
            </div>
          </div>
          <Advice items={d.findings} />
        </section>

        <section className="panel chart-panel">
          <AreaChart data={series} color="var(--gold)" title="Failed SSH logins per hour — 7 days" unit="" max="auto" stepMs={3600e3}
            from={Date.now() - 7 * 864e5} to={Date.now()} now={s.failsLastHour} fmt={(v, axis) => (axis ? `${Math.round(v)}` : `${Math.round(v).toLocaleString()} / h`)} />
        </section>

        <section className="panel">
          <h2>Who is attacking <span className="muted h2-sub">top addresses, last 24 h</span></h2>
          <div className="table-scroll">
            <table className="t">
              <thead><tr><th>Address</th><th className="num">Attempts</th><th>User names tried</th><th>First</th><th>Last</th></tr></thead>
              <tbody>
                {s.topIps.length ? s.topIps.map((r) => (
                  <tr key={r.ip}>
                    <td className="mono">{r.ip}</td>
                    <td className="num">{r.n.toLocaleString()}</td>
                    <td className="mono muted">{r.users.join(', ')}</td>
                    <td className="mono">{fmtDateTime(r.first)}</td>
                    <td className="mono">{fmtDateTime(r.last)}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="muted">No failed logins in the last 24 h.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <h2>Successful SSH logins <span className="muted h2-sub">last 30 days · check these were you</span></h2>
          <div className="table-scroll">
            <table className="t">
              <thead><tr><th>When</th><th>User</th><th>From</th><th>Method</th><th /></tr></thead>
              <tbody>
                {s.logins.length ? s.logins.map((l) => (
                  <tr key={`${l.ts}${l.ip}${l.user}`}>
                    <td className="mono">{fmtDateTime(l.ts)}</td>
                    <td className="mono">{l.user}</td>
                    <td className="mono">{l.ip}</td>
                    <td>{l.method === 'publickey' ? 'key' : l.method}</td>
                    <td>{l.newIp && <span className="lv-tag lv-warn">new address</span>}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="muted">None recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted note">History starts {fmtDateTime(s.historyStart)} (the last 7 days of auth.log at first run; those addresses count as known). "New address" = an address never seen before, in the last 7 days.</p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Listening ports <span className="muted h2-sub">firewall default: IPv4 {d.firewall.v4Policy}, IPv6 {d.firewall.v6Policy}</span></h2>
            <label className="toggle compact">
              <input type="checkbox" checked={showLocal} onChange={(e) => setShowLocal(e.target.checked)} />
              <span>show local-only</span>
            </label>
          </div>
          <div className="table-scroll">
            <table className="t">
              <thead><tr><th>Port</th><th>Address</th><th>Process</th><th>Reachable from</th><th /></tr></thead>
              <tbody>
                {ports.map((p) => (
                  <tr key={`${p.proto}${p.addr}${p.port}`} className={p.known ? '' : 'row-down'}>
                    <td className="mono">{p.proto}/{p.port}</td>
                    <td className="mono">{p.addr}</td>
                    <td className="mono">{p.process}</td>
                    <td><span className={`lv-tag ${EXPOSURE_CLS[p.exposure.level]}`}>{p.exposure.label}</span>{p.transient && <span className="muted cert-where"> · {p.transient}</span>}</td>
                    <td className="num">{!p.known && <button type="button" className="link-btn" onClick={() => markKnown(p)} disabled={busy}>mark as known</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted note">A port that starts listening on a public address and is not in the known list raises an alert. The ports open on the first run were taken as known.</p>
        </section>

        <section className="panel specs specs-wide">
          <h2>SSH &amp; protection</h2>
          <div className="spec-grid">
            <div><span className="spec-k">SSH port</span><span className="mono">{sshd.port || '—'}</span></div>
            <div><span className="spec-k">Root login</span><span className={`mono ${sshd.permitrootlogin === 'yes' ? 'bad-text' : ''}`}>{sshd.permitrootlogin || '—'}</span></div>
            <div><span className="spec-k">Password login</span><span className={`mono ${sshd.passwordauthentication === 'yes' ? 'bad-text' : ''}`}>{sshd.passwordauthentication || '—'}</span></div>
            <div><span className="spec-k">Key login</span><span className="mono">{sshd.pubkeyauthentication || '—'}</span></div>
            <div><span className="spec-k">Tries per connection</span><span className="mono">{sshd.maxauthtries || '—'}</span></div>
            <div><span className="spec-k">fail2ban</span><span className={`mono ${d.fail2ban.installed ? '' : 'bad-text'}`}>
              {d.fail2ban.installed ? (d.fail2ban.sshdJail ? `on · ${d.fail2ban.banned} banned now · ${d.fail2ban.totalBanned} total` : 'installed, no sshd jail') : 'not installed'}
              {d.fail2ban.sshdJail && <> · <a href="/console" onClick={go('/console')}>manage bans →</a></>}</span></div>
            <div><span className="spec-k">Reboot</span><span className="mono">{d.reboot?.required ? 'required' : 'not needed'}</span></div>
            <div><span className="spec-k">Last backup</span><span className={`mono ${d.backup && d.backup.present && d.backup.ok ? '' : 'bad-text'}`}>
              {!d.backup || !d.backup.present ? 'never' : `${fmtDateTime(d.backup.finishedAt)} · ${(d.backup.sizeBytes / 1048576).toFixed(0)} MB${d.backup.ok ? '' : ' · FAILED'}`}</span></div>
            <div><span className="spec-k">Updates</span><span className="mono">{d.updates ? `${d.updates.total} (${d.updates.security} security)` : '—'}</span></div>
          </div>
          {d.updates && d.updates.packages.length > 0 && (
            <details className="updates">
              <summary>Show the {d.updates.total} package update(s)</summary>
              <div className="mono muted update-list">{d.updates.packages.map((u) => `${u.name}${u.security ? ' (security)' : ''}`).join(' · ')}</div>
            </details>
          )}
        </section>
      </main>
    </>
  );
}
