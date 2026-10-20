// A single headline number with a thin usage bar underneath. For CPU/RAM/disk
// the bar turns gold >75% and danger >90% (status encoding, with the % shown).
import { level } from '../format.js';

export default function StatTile({ label, value, unit, sub, pct }) {
  const lv = typeof pct === 'number' ? level(pct) : null;
  return (
    <div className="tile-stat">
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}{unit && <span className="tile-unit">{unit}</span>}
      </div>
      {typeof pct === 'number' && (
        <div className="tile-track">
          <div className={`tile-fill ${lv}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}
