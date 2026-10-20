// Top-of-dashboard banner: red glass when something is firing, quiet when all
// is clear. Reuses the portfolio's panel-danger glow.
export default function AlertBanner({ alerts }) {
  const firing = alerts && alerts.length > 0;
  return (
    <div className={`alert-banner ${firing ? 'firing' : 'clear'}`}>
      <h3>{firing ? `${alerts.length} active alert${alerts.length > 1 ? 's' : ''}` : 'All clear'}</h3>
      {firing ? (
        <ul>
          {alerts.map((a, i) => (
            <li key={i}>
              <strong>{a.server}</strong> · {a.rule}{a.target ? ` (${a.target})` : ''} — {a.detail}
              <span className="muted"> · since {new Date(a.since).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No alerts firing across the fleet.</p>
      )}
    </div>
  );
}
