import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import { api } from '../api.js';

// Scoped actions console: a fixed list of operations (see src/server/actions.js),
// never a shell. Password before anything; the password stays in memory on this
// page only and is re-checked by the server on every run. Every run is audited.

function Unlock({ onUnlock }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.consoleUnlock(pw); onUnlock(pw); }
    catch (e2) { setErr(e2.status === 429 ? e2.message : 'Incorrect password.'); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel form-card unlock">
      <h2>Unlock the console</h2>
      <p className="muted">These buttons restart, stop or start apps and reload nginx on the live server. Re-enter the dashboard password to continue.</p>
      <form onSubmit={submit}>
        <input type="password" placeholder="Dashboard password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <button type="submit" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <div className="login-err">{err}</div>
      </form>
    </section>
  );
}

// What each action does, in words, for the confirmation step.
const CONFIRM = {
  'pm2.restart': (n) => `Restart "${n}"? It is unavailable for a few seconds.`,
  'pm2.stop': (n) => `Stop "${n}"? Its site stops working until you start it again.`,
  'pm2.start': null,
  'pm2.flush': (n) => `Empty the log files of "${n}"? The current log lines are deleted.`,
  'nginx.test': null,
  'fail2ban.status': null,
  'fail2ban.unban': (ip) => `Unban ${ip} so it can try SSH logins again?`,
  'fail2ban.ban': (ip) => `Ban ${ip} from SSH now (for the jail's ban time)?`,
  'fail2ban.forget': (ip) => `Unban ${ip} and forget its past bans (its next ban starts at the base time again)?`,
  'fail2ban.unbanall': () => 'Unban EVERY address now? Attackers will be able to retry until they are banned again.',
  'fail2ban.allow': (ip) => `Never ban ${ip}? Only do this for your own fixed addresses.`,
  'fail2ban.disallow': (ip) => `Remove ${ip} from the allow-list (it can be banned again)?`,
  'nginx.reload': () => 'Reload nginx? The config is tested first; nothing happens if the test fails.',
};

function AuditLog({ refreshKey }) {
  const [lines, setLines] = useState(null);
  useEffect(() => { api.actionsLog().then((d) => setLines(d.lines || [])).catch(() => setLines([])); }, [refreshKey]);
  return (
    <section className="panel">
      <h2>Audit log <span className="muted h2-sub">data/actions.log · newest first</span></h2>
      {!lines ? <div className="muted">Loading…</div>
        : lines.length ? <pre className="logbox">{lines.join('\n')}</pre> : <div className="muted">No actions run yet.</div>}
    </section>
  );
}

const fmtLeft = (sec) => (sec == null ? 'permanent' : sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.max(1, Math.round(sec / 60))} min`);

// fail2ban: every banned address with what it did, and the buttons to manage the list.
function BanManager({ act, running, runs, ip, setIp }) {
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => api.fail2ban().then((x) => { if (alive) setD(x); }).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [runs]);
  if (!d) return <div className="panel"><h2>fail2ban</h2><div className="muted">Loading…</div></div>;
  if (!d.available) return <div className="panel"><h2>fail2ban</h2><div className="bad-text">{d.reason}</div></div>;
  const rows = d.banned.filter((b) => !q || b.ip.includes(q.trim()) || b.users.some((u) => u.includes(q.trim())));
  const busy = !!running;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>fail2ban <span className="muted h2-sub">SSH · {d.banned.length} banned now · {d.totalBanned} since start · rule: {d.rules.maxretry} fails in {Math.round(d.rules.findtimeSec / 60)} min → {Math.round(d.rules.bantimeSec / 60)} min, longer for repeat offenders</span></h2>
        <div className="panel-actions">
          <button type="button" className="secondary small danger-outline" disabled={busy || !d.banned.length} onClick={() => act('fail2ban.unbanall')}>Unban all</button>
        </div>
      </div>
      <div className="action-row">
        <input type="text" className="ip-input mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IP address" aria-label="IP address" />
        <div className="action-btns">
          <button type="button" className="secondary" disabled={busy} onClick={() => act('fail2ban.ban', ip.trim())}>Ban</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => act('fail2ban.unban', ip.trim())}>Unban</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => act('fail2ban.allow', ip.trim())}>Allow (never ban)</button>
        </div>
        <span className="muted note">Your address now: <span className="mono">{d.you}</span></span>
      </div>
      <div className="filters" style={{ marginTop: 12 }}>
        <input type="text" placeholder="Filter by address or user name…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-scroll">
        <table className="t">
          <thead><tr><th>Address</th><th>Banned</th><th>Ends in</th><th className="num">Times banned</th><th className="num">Tries 24 h</th><th>User names tried</th><th /></tr></thead>
          <tbody>
            {rows.length ? rows.map((b) => (
              <tr key={b.ip}>
                <td className="mono">{b.ip}</td>
                <td className="mono">{new Date(b.since).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="mono">{fmtLeft(b.remainingSec)}</td>
                <td className="num">{b.timesBanned}</td>
                <td className="num">{b.attempts24h || '—'}</td>
                <td className="mono muted users-cell" title={b.users.join(', ')}>{b.users.join(', ') || '—'}</td>
                <td className="num row-actions">
                  <button type="button" className="link-btn" disabled={busy} onClick={() => act('fail2ban.unban', b.ip)}>Unban</button>
                  <button type="button" className="link-btn" disabled={busy} onClick={() => act('fail2ban.forget', b.ip)}>Unban &amp; forget</button>
                  <button type="button" className="link-btn" disabled={busy} onClick={() => act('fail2ban.allow', b.ip)}>Allow</button>
                </td>
              </tr>
            )) : <tr><td colSpan={7} className="muted">{d.banned.length ? 'No match.' : 'Nobody is banned right now.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <h2 style={{ marginTop: 18 }}>Allow-list <span className="muted h2-sub">never banned · saved in {d.jailFile}</span></h2>
      <div className="chips">
        {d.allowed.map((a) => (
          <span key={a} className="chip mono">{a}
            {!/^127\.|^::1$/.test(a) && !(d.serverIps || []).includes(a) && <button type="button" className="link-btn" disabled={busy} onClick={() => act('fail2ban.disallow', a)} aria-label={`Remove ${a}`}>×</button>}
          </span>
        ))}
      </div>
      <p className="muted note">Unban & forget also clears the address's ban history, so a new ban starts again at {Math.round(d.rules.bantimeSec / 60)} min. Bans only block SSH (port 22): websites and this dashboard stay reachable. You cannot ban this server, loopback or your own current address.</p>
    </div>
  );
}

function ActionsPanel({ password, onLock }) {
  const [list, setList] = useState([]);
  const [procs, setProcs] = useState([]);
  const [proc, setProc] = useState('');
  const [out, setOut] = useState(null);
  const [running, setRunning] = useState('');
  const [runs, setRuns] = useState(0);
  const [ip, setIp] = useState('');

  useEffect(() => {
    api.actions().then((d) => setList(d.actions || [])).catch(() => {});
    api.whoami().then((w) => setIp(w.ip || '')).catch(() => {});
    api.metrics().then((m) => {
      const names = ((m.server && m.server.pm2) || []).map((p) => ({ name: p.name, status: p.status }));
      setProcs(names);
      const wanted = new URLSearchParams(window.location.search).get('app');
      setProc(names.some((p) => p.name === wanted) ? wanted : (names[0] || {}).name || '');
    }).catch(() => {});
  }, []);

  async function run(a, explicitArg) {
    if (!a) return;
    const arg = explicitArg !== undefined ? explicitArg : a.needs === 'process' ? proc : a.needs === 'ip' ? ip.trim() : undefined;
    if (a.needs === 'ip' && !arg) { setOut({ ok: false, output: 'Enter an address first.' }); return; }
    if (a.needs === 'process' && !arg) { setOut({ ok: false, output: 'Pick an app first.' }); return; }
    const ask = CONFIRM[a.id];
    if (ask && !window.confirm(ask(arg))) return;
    setRunning(a.id); setOut(null);
    try {
      const r = await api.runAction(a.id, arg, password);
      setOut({ ok: r.ok, title: `${a.label}${arg ? ` · ${arg}` : ''}`, output: r.output || (r.ok ? 'done' : r.error || 'failed'), code: r.code });
    } catch (e) {
      if (e.status === 401) { onLock(); return; }
      setOut({ ok: false, title: a.label, output: (e.data && e.data.error) || e.message });
    } finally { setRunning(''); setRuns((n) => n + 1); }
  }

  const procActions = list.filter((a) => a.needs === 'process');
  const nginxActions = list.filter((a) => a.id.startsWith('nginx.'));
  const act = (id, arg) => run(list.find((a) => a.id === id), arg);
  const hasF2b = list.some((a) => a.id.startsWith('fail2ban.'));
  const current = procs.find((p) => p.name === proc);

  return (
    <>
      <div className="actions">
        <div className="panel">
          <div className="panel-head">
            <h2>pm2 apps</h2>
            <button type="button" className="link-btn" onClick={onLock}>Lock console</button>
          </div>
          <div className="action-row">
            <select value={proc} onChange={(e) => setProc(e.target.value)} aria-label="App">
              {procs.length ? procs.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.status})</option>) : <option value="">(none)</option>}
            </select>
            <div className="action-btns">
              {procActions.map((a) => (
                <button key={a.id} type="button" className={`secondary ${a.id === 'pm2.stop' ? 'danger-outline' : ''}`} disabled={!!running} onClick={() => run(a)}>
                  {running === a.id ? '…' : a.label.replace(' a pm2 app', '').replace(' a pm2 app log', ' log')}
                </button>
              ))}
            </div>
          </div>
          {current && <p className="muted note">Selected: <span className="mono">{current.name}</span> is {current.status}. Stopping "monitoring" (this dashboard) is refused here.</p>}
        </div>

        <div className="panel">
          <h2>nginx</h2>
          <div className="action-btns">
            {nginxActions.map((a) => (
              <button key={a.id} type="button" className="secondary" disabled={!!running} onClick={() => run(a)}>
                {running === a.id ? '…' : a.label}
              </button>
            ))}
          </div>
        </div>

        {hasF2b && <BanManager act={act} running={running} runs={runs} ip={ip} setIp={setIp} />}

        {out && (
          <div className={`panel out ${out.ok ? '' : 'out-err'}`}>
            <div className="out-head">{out.ok ? '✓ ok' : '✗ failed'} · {out.title}{out.code !== undefined ? ` · exit ${out.code}` : ''}</div>
            <pre>{out.output || '(no output)'}</pre>
          </div>
        )}
      </div>
      <AuditLog refreshKey={runs} />
    </>
  );
}

export default function Console() {
  const [password, setPassword] = useState(null);
  return (
    <>
      <Header active="/console" sub="console" />
      <main className="wrap">
        {!password ? <Unlock onUnlock={setPassword} /> : <ActionsPanel password={password} onLock={() => setPassword(null)} />}
      </main>
    </>
  );
}
