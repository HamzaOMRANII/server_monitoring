// Top-of-dashboard banner: red glass when something is firing, quiet when all
// is clear. Reuses the portfolio's panel-danger glow.
const RULE_LABELS = {
  cpuPercent: 'CPU', memPercent: 'RAM', diskPercent: 'Disk', pm2Restart: 'pm2 restarts',
  siteDown: 'Site down', sslExpiry: 'Certificate expiry',
};

export default function AlertBanner({ alerts }) {
  const firing = alerts && alerts.length > 0;
  return (
    <div className={`alert-banner ${firing ? 'firing' : 'clear'}`}>
      <h3>{firing ? `${alerts.length} active alert${alerts.length > 1 ? 's' : ''}` : 'All clear'}</h3>
      {firing ? (
        <ul>
          {alerts.map((a, i) => (
            <li key={i}>
              <strong>{RULE_LABELS[a.rule] || a.rule}</strong>{a.target ? ` · ${a.target}` : ''} — {a.detail}
              <span className="muted"> · since {new Date(a.since).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No alerts firing on this server.</p>
      )}
    </div>
  );
}
