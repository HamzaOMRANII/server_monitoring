'use strict';

// Front-end logic for the dashboard and settings pages. Vanilla JS, no build
// step — served statically by central behind the login gate.

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtUptime(s) {
  if (!s && s !== 0) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function levelClass(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return '';
}

function meter(label, pct, detail) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="meter">
    <div class="label"><span>${label}</span><span>${p.toFixed(0)}%${detail ? ` · ${detail}` : ''}</span></div>
    <div class="track"><div class="fill ${levelClass(p)}" style="width:${p}%"></div></div>
  </div>`;
}

function pm2Badge(status) {
  const s = (status || '').toLowerCase();
  const cls = s === 'online' ? 'online' : (s === 'stopped' || s === 'errored') ? s : 'other';
  return `<span class="badge ${cls}">${status || 'unknown'}</span>`;
}

function serverCard(s) {
  const specs = s.specs || {};
  const disksRows = (s.disks || []).map((d) =>
    `<tr><td>${d.mount}</td><td class="num">${d.usedPercent.toFixed(0)}%</td>
     <td class="num muted">${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)}</td></tr>`).join('');

  const pm2Rows = (s.pm2 || []).map((p) =>
    `<tr><td>${p.name}</td><td>${pm2Badge(p.status)}</td>
     <td class="num">${p.cpu ?? '—'}%</td><td class="num">${fmtBytes(p.memoryBytes)}</td>
     <td class="num">${p.restarts ?? '—'}</td></tr>`).join('') ||
    `<tr><td colspan="5" class="muted">No pm2 processes reported.</td></tr>`;

  const sites = ((s.nginx && s.nginx.sites) || []).map((site) => {
    let expiry = '';
    if (site.certExpiryDays !== null && site.certExpiryDays !== undefined) {
      const cls = site.certExpiryDays < 0 ? 'expired' : site.certExpiryDays < 14 ? 'soon' : '';
      const txt = site.certExpiryDays < 0 ? 'EXPIRED' : `${site.certExpiryDays}d`;
      expiry = `<span class="pill-expiry ${cls}">cert ${txt}</span>`;
    }
    return `<tr><td>${site.serverNames.join(', ') || site.file}</td>
      <td class="muted">${(site.upstreams || []).join(', ') || '—'}</td>
      <td class="num">${expiry}</td></tr>`;
  }).join('') || `<tr><td colspan="3" class="muted">No nginx sites found.</td></tr>`;

  return `<div class="card">
    <h2>${s.server}</h2>
    <div class="host">${specs.hostname || ''} · ${specs.platform || ''} · ${(specs.ips || []).map((i) => i.ip).join(', ') || 'no IP'}</div>

    <div class="meters">
      ${meter('CPU', s.cpuPercent)}
      ${meter('RAM', s.memPercent, fmtBytes(s.memory && s.memory.usedBytes))}
    </div>

    <div class="section-title">Disks</div>
    <table><tbody>${disksRows || '<tr><td class="muted">—</td></tr>'}</tbody></table>

    <div class="section-title">Apps (pm2)</div>
    <table>
      <thead><tr><th>Name</th><th>Status</th><th>CPU</th><th>Mem</th><th>Restarts</th></tr></thead>
      <tbody>${pm2Rows}</tbody>
    </table>

    <div class="section-title">nginx sites</div>
    <table>
      <thead><tr><th>Server name</th><th>Upstream</th><th>TLS</th></tr></thead>
      <tbody>${sites}</tbody>
    </table>

    <div class="section-title">Specs</div>
    <table><tbody>
      <tr><td>CPU</td><td>${specs.cpuCount || '?'} × ${specs.cpuModel || '—'}</td></tr>
      <tr><td>Memory</td><td>${fmtBytes(specs.totalMemBytes)}</td></tr>
      <tr><td>Uptime</td><td>${fmtUptime(specs.uptimeSeconds)}</td></tr>
      <tr><td>Load avg</td><td class="muted">${(specs.loadavg || []).map((n) => n.toFixed(2)).join('  ')}</td></tr>
    </tbody></table>
  </div>`;
}

function renderAlerts(alerts) {
  const box = document.getElementById('alerts');
  const body = document.getElementById('alerts-body');
  if (!alerts || !alerts.length) {
    box.className = 'alert-banner clear';
    body.innerHTML = 'All clear — nothing firing.';
    return;
  }
  box.className = 'alert-banner';
  body.innerHTML = '<ul>' + alerts.map((a) =>
    `<li><strong>${a.server}</strong> · ${a.rule}${a.target ? ` (${a.target})` : ''} — ${a.detail || ''}
     <span class="muted">since ${new Date(a.since).toLocaleTimeString()}</span></li>`).join('') + '</ul>';
}

async function dashboard() {
  document.getElementById('logout').addEventListener('click', logout);
  async function refresh() {
    try {
      const res = await fetch('/api/overview');
      if (res.status === 401) { window.location.href = '/login.html'; return; }
      const data = await res.json();
      renderAlerts(data.alerts);
      const grid = document.getElementById('servers');
      grid.innerHTML = (data.servers || []).map(serverCard).join('') ||
        '<div class="card muted">No agents reporting yet. Start an agent pointed at this central.</div>';
    } catch (e) {
      console.error(e);
    }
  }
  refresh();
  setInterval(refresh, 5000);
}

async function logout(e) {
  if (e) e.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

/* ---------- settings ---------- */

async function settingsPage() {
  document.getElementById('logout').addEventListener('click', logout);
  const res = await fetch('/api/settings');
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const s = await res.json();

  // thresholds
  const rulesBox = document.getElementById('rules');
  const ruleDefs = [
    ['cpuPercent', 'CPU %'],
    ['memPercent', 'RAM %'],
    ['diskPercent', 'Disk %'],
  ];
  rulesBox.innerHTML = ruleDefs.map(([key, label]) => {
    const r = (s.alertRules && s.alertRules[key]) || {};
    return `<div class="row" data-rule="${key}">
      <div class="field toggle"><input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''}/><label>${label}</label></div>
      <div class="field"><label>Threshold</label><input type="number" data-k="threshold" value="${r.threshold ?? ''}"/></div>
      <div class="field"><label>Remind every (min)</label><input type="number" data-k="remindMinutes" value="${r.remindMinutes ?? ''}"/></div>
    </div>`;
  }).join('');

  // receivers
  const em = (s.receivers && s.receivers.email) || {};
  const smtp = em.smtp || {};
  document.getElementById('email-enabled').checked = !!em.enabled;
  document.getElementById('email-to').value = (em.to || []).join(', ');
  document.getElementById('email-from').value = em.from || '';
  document.getElementById('smtp-host').value = smtp.host || '';
  document.getElementById('smtp-port').value = smtp.port || '';
  document.getElementById('smtp-user').value = smtp.user || '';

  const tg = (s.receivers && s.receivers.telegram) || {};
  document.getElementById('tg-enabled').checked = !!tg.enabled;
  document.getElementById('tg-chat').value = tg.chatId || '';

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const alertRules = {};
    document.querySelectorAll('[data-rule]').forEach((row) => {
      const key = row.getAttribute('data-rule');
      alertRules[key] = {
        enabled: row.querySelector('[data-k=enabled]').checked,
        threshold: Number(row.querySelector('[data-k=threshold]').value),
        remindMinutes: Number(row.querySelector('[data-k=remindMinutes]').value),
      };
    });

    const patch = {
      alertRules,
      receivers: {
        email: {
          enabled: document.getElementById('email-enabled').checked,
          to: document.getElementById('email-to').value.split(',').map((x) => x.trim()).filter(Boolean),
          from: document.getElementById('email-from').value,
          smtp: {
            host: document.getElementById('smtp-host').value,
            port: Number(document.getElementById('smtp-port').value) || 587,
            user: document.getElementById('smtp-user').value,
            pass: document.getElementById('smtp-pass').value, // blank = keep
          },
        },
        telegram: {
          enabled: document.getElementById('tg-enabled').checked,
          botToken: document.getElementById('tg-token').value, // blank = keep
          chatId: document.getElementById('tg-chat').value,
        },
      },
    };

    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const saved = document.getElementById('saved');
    saved.textContent = r.ok ? 'Saved ✓' : 'Save failed';
    setTimeout(() => (saved.textContent = ''), 2500);
  });
}
