import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go } from '../router.js';

function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="w-it">mon</span><span className="w-light">itoring</span>
        <span className="brand-sub">console</span>
      </div>
      <nav>
        <a href="/" onClick={go('/')}>Dashboard</a>
        <a href="/console" className="active" onClick={go('/console')}>Console</a>
        <a href="/settings" onClick={go('/settings')}>Settings</a>
        <a href="/login" onClick={async (e) => { e.preventDefault(); await api.logout(); go('/login')(); }}>Sign out</a>
      </nav>
    </header>
  );
}

// Password-before-anything gate. Re-verifies the dashboard password, then the
// client keeps it in memory and sends it with each run (re-checked server-side).
function Unlock({ onUnlock }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.consoleUnlock(pw); onUnlock(pw); }
    catch { setErr('Incorrect password.'); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel form-card unlock">
      <h2>Unlock the console</h2>
      <p className="muted">These run privileged operations on the server. Re-enter the dashboard password to continue.</p>
      <form onSubmit={submit}>
        <input type="password" placeholder="Dashboard password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <button type="submit" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <div className="login-err">{err}</div>
      </form>
    </section>
  );
}

function ActionsPanel({ password }) {
  const [list, setList] = useState([]);
  const [procs, setProcs] = useState([]);
  const [proc, setProc] = useState('');
  const [out, setOut] = useState(null);
  const [running, setRunning] = useState('');

  useEffect(() => {
    api.actions().then((d) => setList(d.actions || [])).catch(() => {});
    api.metrics().then((m) => {
      const names = ((m.server && m.server.pm2) || []).map((p) => p.name);
      setProcs(names); setProc(names[0] || '');
    }).catch(() => {});
  }, []);

  async function run(a) {
    const arg = a.needs === 'process' ? proc : undefined;
    if (a.needs === 'process' && !arg) { setOut({ ok: false, output: 'Pick a process first.' }); return; }
    setRunning(a.id); setOut(null);
    try {
      const r = await api.runAction(a.id, arg, password);
      setOut({ ok: r.ok, output: r.output || (r.ok ? 'done' : r.error || 'failed'), code: r.code });
    } catch (e) { setOut({ ok: false, output: e.message }); }
    finally { setRunning(''); }
  }

  const procActions = list.filter((a) => a.needs === 'process');
  const plainActions = list.filter((a) => a.needs !== 'process');

  return (
    <div className="actions">
      <div className="panel">
        <h2>pm2 apps</h2>
        <div className="action-row">
          <select value={proc} onChange={(e) => setProc(e.target.value)}>
            {procs.length ? procs.map((n) => <option key={n} value={n}>{n}</option>) : <option value="">(none)</option>}
          </select>
          <div className="action-btns">
            {procActions.map((a) => (
              <button key={a.id} className="secondary" disabled={running === a.id} onClick={() => run(a)}>
                {running === a.id ? '…' : a.label.replace(' a pm2 app', '')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>nginx</h2>
        <div className="action-btns">
          {plainActions.map((a) => (
            <button key={a.id} className="secondary" disabled={running === a.id} onClick={() => run(a)}>
              {running === a.id ? '…' : a.label}
            </button>
          ))}
        </div>
      </div>

      {out && (
        <div className={`panel out ${out.ok ? '' : 'out-err'}`}>
          <div className="out-head">{out.ok ? '✓ ok' : '✗ failed'}{out.code !== undefined ? ` · exit ${out.code}` : ''}</div>
          <pre>{out.output || '(no output)'}</pre>
        </div>
      )}
    </div>
  );
}

export default function Console() {
  const [password, setPassword] = useState(null);
  return (
    <>
      <Header />
      <main className="wrap">
        {!password ? <Unlock onUnlock={setPassword} /> : <ActionsPanel password={password} />}
      </main>
    </>
  );
}
