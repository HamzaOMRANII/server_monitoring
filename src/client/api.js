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
};
