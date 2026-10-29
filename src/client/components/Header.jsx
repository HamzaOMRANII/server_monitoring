// Top bar shared by every page: brand, a sub-label (the hostname with a live dot
// on the dashboard, the page name elsewhere) and the navigation.
import { api } from '../api.js';
import { go } from '../router.js';

const LINKS = [
  ['/', 'Dashboard'],
  ['/uptime', 'Uptime'],
  ['/alerts', 'Alerts'],
  ['/logs', 'Logs'],
  ['/settings', 'Settings'],
];

export default function Header({ active, sub, live }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="w-it">mon</span><span className="w-light">itoring</span>
        {sub && <span className="brand-sub">{live && <><span className="live-dot" /> </>}{sub}</span>}
      </div>
      <nav>
        {LINKS.map(([href, label]) => (
          <a key={href} href={href} className={active === href ? 'active' : undefined} onClick={go(href)}>{label}</a>
        ))}
        <a href="/login" onClick={async (e) => { e.preventDefault(); await api.logout(); go('/login')(); }}>Sign out</a>
      </nav>
    </header>
  );
}
