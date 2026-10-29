// Thin fetch wrapper. On 401 it bounces to /login so an expired session never
// leaves the UI in a broken state.
import { go } from './router.js';

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.endsWith('/login')) {
    go('/login')();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  login: (password) => req('POST', '/api/login', { password }),
  logout: () => req('POST', '/api/logout'),
  metrics: () => req('GET', '/api/metrics'),
  history: (minutes = 60) => req('GET', `/api/history?minutes=${minutes}`),
  getSettings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  testEmail: () => req('POST', '/api/settings/test-email'),

  alertHistory: (days, rule, q) =>
    req('GET', `/api/alerts/history?days=${days}&rule=${encodeURIComponent(rule || '')}&q=${encodeURIComponent(q || '')}`),
  uptime: () => req('GET', '/api/uptime'),
  uptimeSummary: () => req('GET', '/api/uptime/summary'),
  uptimeCheck: () => req('POST', '/api/uptime/check'),
  uptimeIgnore: (name, ignored) => req('POST', '/api/uptime/ignore', { name, ignored }),

  consoleUnlock: (password) => req('POST', '/api/console/unlock', { password }),
  actions: () => req('GET', '/api/actions'),
  runAction: (id, arg, password) => req('POST', '/api/actions/run', { id, arg, password }),

  logSources: () => req('GET', '/api/logs/sources'),
  logTail: (source, lines, q) =>
    req('GET', `/api/logs/tail?source=${encodeURIComponent(source)}&lines=${lines}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
};
