// A labelled usage bar. Turns gold past 75%, danger past 90% — the same
// gold/danger tokens as the portfolio status colors.
export default function Meter({ label, pct, detail }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const level = p >= 90 ? 'crit' : p >= 75 ? 'warn' : '';
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <span className="meter-val">{p.toFixed(0)}%{detail ? ` · ${detail}` : ''}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${level}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}
