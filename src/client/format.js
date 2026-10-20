// Small formatting helpers shared across the dashboard.

const U = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  let i = 0;
  while (n >= 1024 && i < U.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${U[i]}`;
}

export function fmtUptime(s) {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Threshold level for a 0–100 percentage → token class suffix.
export function level(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}
