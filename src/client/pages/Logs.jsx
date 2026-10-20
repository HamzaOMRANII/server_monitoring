import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { go } from '../router.js';

function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="w-it">mon</span><span className="w-light">itoring</span>
        <span className="brand-sub">logs</span>
      </div>
      <nav>
        <a href="/" onClick={go('/')}>Dashboard</a>
        <a href="/logs" className="active" onClick={go('/logs')}>Logs</a>
        <a href="/settings" onClick={go('/settings')}>Settings</a>
        <a href="/login" onClick={async (e) => { e.preventDefault(); await api.logout(); go('/login')(); }}>Sign out</a>
      </nav>
    </header>
  );
}

// Colour a line by its log level so errors jump out.
function lineClass(l) {
  const s = l.toLowerCase();
  if (/\b(error|err|fatal|panic|exception|\[emerg\]|\[crit\])\b/.test(s)) return 'lg-err';
  if (/\b(warn|warning|\[warn\])\b/.test(s)) return 'lg-warn';
  if (/\b(info|notice|200|debug)\b/.test(s)) return 'lg-dim';
  return '';
}

export default function Logs() {
  const [sources, setSources] = useState([]);
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [lines, setLines] = useState(300);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState('');
  const [auto, setAuto] = useState(true);
  const [err, setErr] = useState('');
  const view = useRef(null);
  const pinned = useRef(true); // stay stuck to the bottom unless the user scrolls up

  useEffect(() => {
    api.logSources().then((d) => {
      setSources(d.sources || []);
      if (d.sources && d.sources.length) setSource(d.sources[0].id);
    }).catch(() => setErr('Could not list log sources.'));
  }, []);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    async function load() {
      try {
        const d = await api.logTail(source, lines, q);
        if (!alive) return;
        if (d.error) { setErr(d.error); setRows([]); return; }
        setErr(''); setMeta(`${d.label} · ${d.lines.length} lines`); setRows(d.lines);
      } catch (e) { if (alive && e.message !== 'unauthorized') setErr('Could not read log.'); }
    }
    load();
    const id = auto ? setInterval(load, 3000) : null;
    return () => { alive = false; if (id) clearInterval(id); };
  }, [source, q, lines, auto]);

  // keep scrolled to bottom when pinned
  useEffect(() => {
    const el = view.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  function onScroll() {
    const el = view.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  return (
    <>
      <Header />
      <main className="wrap">
        <div className="panel logs-panel">
          <div className="logs-bar">
            <select value={source} onChange={(e) => { pinned.current = true; setSource(e.target.value); }}>
              {sources.length ? sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)
                : <option value="">(no sources)</option>}
            </select>
            <input className="logs-search" type="text" placeholder="filter… (e.g. error)" value={q}
              onChange={(e) => { pinned.current = true; setQ(e.target.value); }} />
            <select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
              {[100, 300, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n} lines</option>)}
            </select>
            <label className="toggle logs-auto">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              <span>live</span>
            </label>
            <span className="muted logs-meta">{err ? <span className="lg-err">{err}</span> : meta}</span>
          </div>
          <div className="logs-view" ref={view} onScroll={onScroll}>
            {rows.length ? rows.map((l, i) => (
              <div key={i} className={`logs-line ${lineClass(l)}`}>{l || ' '}</div>
            )) : <div className="muted logs-empty">{err || 'no matching lines'}</div>}
          </div>
        </div>
      </main>
    </>
  );
}
