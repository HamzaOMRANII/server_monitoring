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

function ActionsPanel({ password, onLock }) {
  const [list, setList] = useState([]);
  const [procs, setProcs] = useState([]);
  const [proc, setProc] = useState('');
  const [out, setOut] = useState(null);
  const [running, setRunning] = useState('');
  const [runs, setRuns] = useState(0);

  useEffect(() => {
    api.actions().then((d) => setList(d.actions || [])).catch(() => {});
    api.metrics().then((m) => {
      const names = ((m.server && m.server.pm2) || []).map((p) => ({ name: p.name, status: p.status }));
      setProcs(names);
      const wanted = new URLSearchParams(window.location.search).get('app');
      setProc(names.some((p) => p.name === wanted) ? wanted : (names[0] || {}).name || '');
    }).catch(() => {});
  }, []);

  async function run(a) {
    const arg = a.needs === 'process' ? proc : undefined;
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
  const plainActions = list.filter((a) => a.needs !== 'process');
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
            {plainActions.map((a) => (
              <button key={a.id} type="button" className="secondary" disabled={!!running} onClick={() => run(a)}>
                {running === a.id ? '…' : a.label}
              </button>
            ))}
          </div>
        </div>

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
