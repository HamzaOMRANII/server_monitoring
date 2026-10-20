import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go } from '../router.js';
import AlertBanner from '../components/AlertBanner.jsx';
import ServerCard from '../components/ServerCard.jsx';

function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="w-it">mon</span><span className="w-light">itoring</span>
        <span className="brand-sub">fleet overview</span>
      </div>
      <nav>
        <a href="/" className="active" onClick={go('/')}>Dashboard</a>
        <a href="/settings" onClick={go('/settings')}>Settings</a>
        <a href="/login" onClick={async (e) => { e.preventDefault(); await api.logout(); go('/login')(); }}>Sign out</a>
      </nav>
    </header>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    async function refresh() {
      try {
        const d = await api.overview();
        if (alive) { setData(d); setError(''); }
      } catch (e) {
        if (alive && e.message !== 'unauthorized') setError('Could not reach central.');
      }
    }
    refresh();
    const id = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const servers = data ? data.servers : [];

  return (
    <>
      <Header />
      <main className="wrap">
        <AlertBanner alerts={data ? data.alerts : []} />
        {error && <div className="panel panel-danger">{error}</div>}
        <div className="srv-grid">
          {servers.length
            ? servers.map((s) => <ServerCard key={s.server} snapshot={s} />)
            : (
              <div className="panel">
                No agents reporting yet. Start an agent pointed at this central
                (<code>npm run agent</code>).
              </div>
            )}
        </div>
      </main>
    </>
  );
}
