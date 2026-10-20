import { fmtBytes, level } from '../format.js';

// Storage visualization: a ring gauge for the main (largest) mount, plus a
// labelled used/total bar per mount. Bars are coloured by usage level with the
// % always shown, so colour is never the only signal.

function Ring({ pct }) {
  const r = 52, c = 2 * Math.PI * r;
  const lv = level(pct);
  const stroke = lv === 'crit' ? 'var(--crit)' : lv === 'warn' ? 'var(--warn)' : 'var(--petrol-bright)';
  const off = c * (1 - Math.min(100, pct) / 100);
  return (
    <svg viewBox="0 0 140 140" className="ring" role="img" aria-label={`${pct.toFixed(0)}% used`}>
      <circle cx="70" cy="70" r={r} className="ring-track" strokeWidth="12" fill="none" />
      <circle
        cx="70" cy="70" r={r} fill="none" strokeWidth="12" strokeLinecap="round"
        stroke={stroke} strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 70 70)"
      />
      <text x="70" y="66" className="ring-pct" textAnchor="middle">{pct.toFixed(0)}%</text>
      <text x="70" y="86" className="ring-sub" textAnchor="middle">used</text>
    </svg>
  );
}

export default function StoragePanel({ disks }) {
  const mounts = disks || [];
  if (!mounts.length) {
    return <section className="panel"><h2>Storage</h2><p className="muted">No mounts reported.</p></section>;
  }
  const main = mounts.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a), mounts[0]);

  return (
    <section className="panel storage">
      <h2>Storage</h2>
      <div className="storage-body">
        <div className="storage-ring">
          <Ring pct={main.usedPercent} />
          <div className="storage-ring-cap">
            <div className="mono">{main.mount}</div>
            <div className="muted">{fmtBytes(main.usedBytes)} / {fmtBytes(main.totalBytes)}</div>
            <div className="muted">{fmtBytes(main.totalBytes - main.usedBytes)} free</div>
          </div>
        </div>
        <div className="storage-bars">
          {mounts.map((d) => (
            <div className="sbar" key={d.mount}>
              <div className="sbar-top">
                <span className="mono">{d.mount}</span>
                <span className="muted">{d.usedPercent.toFixed(0)}% · {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)}</span>
              </div>
              <div className="sbar-track">
                <div className={`sbar-fill ${level(d.usedPercent)}`} style={{ width: `${Math.min(100, d.usedPercent)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
