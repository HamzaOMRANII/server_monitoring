import { useRef, useState } from 'react';
import { fmtTime } from '../format.js';

// A single-metric area chart over time (0–100%). One axis, one metric — so no
// legend box; the title names it. On longer ranges each point is a bucket
// average and `p` (the bucket's peak) is drawn as a thin dashed line, labelled
// in the header. Gaps (monitor stopped) break the line instead of bridging it.
// Crosshair + tooltip on hover, per the dataviz interaction rule.
//
// data: [{ ts, v, p? }]   (v may be null for gaps)
// stepMs: spacing of the points (a jump > 2.5 steps is a gap)
export default function AreaChart({ data, color, title, unit = '%', max = 100, height = 120, stepMs = 10000, from, to, now }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);

  const pts = (data || []).filter((d) => typeof d.v === 'number');
  const hasPeak = pts.some((d) => typeof d.p === 'number');
  const W = 560; // viewBox width (scales to container)
  const H = height;
  const padL = 30, padR = 8, padT = 10, padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  if (pts.length < 2) {
    return (
      <div className="chart">
        <div className="chart-head"><span className="chart-title">{title}</span></div>
        <div className="chart-empty" style={{ height }}>{now === undefined ? 'collecting…' : 'not enough history yet — it builds up minute by minute'}</div>
      </div>
    );
  }

  const t0 = from ?? pts[0].ts;
  const t1 = to ?? pts[pts.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const x = (ts) => padL + ((ts - t0) / span) * plotW;
  const y = (v) => padT + (1 - Math.min(v, max) / max) * plotH;

  // split into runs wherever two points are further apart than 2.5 steps
  const runs = [];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (run && p.ts - run[run.length - 1].ts <= stepMs * 2.5) run.push(p);
    else runs.push([p]);
  }
  const line = (run, key) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area = (run) => `${line(run, 'v')} L${x(run[run.length - 1].ts).toFixed(1)},${padT + plotH} L${x(run[0].ts).toFixed(1)},${padT + plotH} Z`;
  const last = now ?? pts[pts.length - 1].v;
  const gid = `g-${title.replace(/\W/g, '')}`;
  const long = span > 36 * 3600e3;
  const tickFmt = (ts) => new Date(ts).toLocaleString([], long ? { day: '2-digit', month: 'short' } : { hour: '2-digit', minute: '2-digit' });
  const ticks = [0, 1, 2, 3].map((i) => t0 + (span * i) / 3);
  const tipFmt = (ts) => (span > 2 * 3600e3 ? new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : fmtTime(ts));

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
        {hasPeak && <span className="chart-key"><i className="k-avg" style={{ background: color }} />avg <i className="k-peak" style={{ borderColor: color }} />peak</span>}
        <span className="chart-now" style={{ color }}>{last == null ? '—' : `${last.toFixed(0)}${unit}`}</span>
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
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} className="chart-grid" />
            <text x={padL - 6} y={y(g) + 3} className="chart-axis" textAnchor="end">{g}</text>
          </g>
        ))}
        {runs.map((run, i) => (
          <g key={i}>
            {run.length > 1 && <path d={area(run)} fill={`url(#${gid})`} />}
            {hasPeak && <path d={line(run.filter((p) => typeof p.p === 'number'), 'p')} fill="none" stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.75" vectorEffect="non-scaling-stroke" />}
            <path d={line(run, 'v')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {hover && (
          <g>
            <line x1={x(hover.ts)} y1={padT} x2={x(hover.ts)} y2={padT + plotH} className="chart-cross" />
            <circle cx={x(hover.ts)} cy={y(hover.v)} r="3.5" fill={color} stroke="var(--navy-950)" strokeWidth="1.5" />
          </g>
        )}
      </svg>
      <div className="chart-xaxis">
        {ticks.map((t, i) => <span key={i}>{tickFmt(t)}</span>)}
      </div>
      {hover && (
        <div className="chart-tip">
          <strong style={{ color }}>{hover.v.toFixed(1)}{unit}</strong>
          {typeof hover.p === 'number' && <span> · peak {hover.p.toFixed(1)}{unit}</span>}
          <span className="muted"> · {tipFmt(hover.ts)}</span>
        </div>
      )}
    </div>
  );
}
