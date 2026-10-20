import { useRef, useState } from 'react';
import { fmtTime } from '../format.js';

// A single-series area+line chart over time (0–100%). One axis, one series —
// so no legend; the title names it. Ships a crosshair + tooltip on hover, per
// the dataviz interaction rule. Colour is passed in (a CSS var from the theme).
//
// data: [{ ts, v }]   (v may be null for gaps)
export default function AreaChart({ data, color, title, unit = '%', max = 100, height = 120 }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);

  const pts = (data || []).filter((d) => typeof d.v === 'number');
  const W = 560; // viewBox width (scales to container)
  const H = height;
  const padL = 30, padR = 8, padT = 10, padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  if (pts.length < 2) {
    return (
      <div className="chart">
        <div className="chart-head"><span className="chart-title">{title}</span></div>
        <div className="chart-empty" style={{ height }}>collecting…</div>
      </div>
    );
  }

  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const x = (ts) => padL + ((ts - t0) / span) * plotW;
  const y = (v) => padT + (1 - Math.min(v, max) / max) * plotH;

  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(t1).toFixed(1)},${padT + plotH} L${x(t0).toFixed(1)},${padT + plotH} Z`;
  const last = pts[pts.length - 1].v;
  const gid = `g-${title.replace(/\W/g, '')}`;

  function onMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ts = t0 + ((px - padL) / plotW) * span;
    let nearest = pts[0];
    for (const p of pts) if (Math.abs(p.ts - ts) < Math.abs(nearest.ts - ts)) nearest = p;
    setHover(nearest);
  }

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-now" style={{ color }}>{last.toFixed(0)}{unit}</span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="chart-svg"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.38" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* gridlines at 25/50/75/100 */}
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} className="chart-grid" />
            <text x={padL - 6} y={y(g) + 3} className="chart-axis" textAnchor="end">{g}</text>
          </g>
        ))}
        <path d={areaPath} fill={`url(#${gid})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {hover && (
          <g>
            <line x1={x(hover.ts)} y1={padT} x2={x(hover.ts)} y2={padT + plotH} className="chart-cross" />
            <circle cx={x(hover.ts)} cy={y(hover.v)} r="3.5" fill={color} stroke="var(--navy-950)" strokeWidth="1.5" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="chart-tip">
          <strong style={{ color }}>{hover.v.toFixed(1)}{unit}</strong>
          <span className="muted"> · {fmtTime(hover.ts)}</span>
        </div>
      )}
    </div>
  );
}
