import { useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import { api } from '../api.js';


const RULES = [
  ['cpuPercent', 'CPU %'],
  ['memPercent', 'RAM %'],
  ['diskPercent', 'Disk %'],
];

// Dashboard password (also unlocks the Console). Stored as a salted hash; changing it
// signs out every other browser, this one stays signed in.
function PasswordCard() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [changedAt, setChangedAt] = useState(undefined);
  useEffect(() => { api.passwordInfo().then((r) => setChangedAt(r.changedAt)).catch(() => {}); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    if (f.next.length < 12) return setMsg({ bad: true, text: 'Use at least 12 characters.' });
    if (f.next !== f.again) return setMsg({ bad: true, text: 'The two new passwords are different.' });
    setBusy(true); setMsg(null);
    try {
      const r = await api.changePassword(f.current, f.next);
      setChangedAt(r.changedAt);
      setF({ current: '', next: '', again: '' });
      setMsg({ bad: false, text: 'Password changed ✓ — other browsers are signed out. Save it in your password manager.' });
    } catch (err) {
      setMsg({ bad: true, text: err.status === 401 ? 'Current password is wrong.' : err.message });
    } finally { setBusy(false); }
  }
  return (
    <form className="panel form-card" onSubmit={submit}>
      <h2>Dashboard password</h2>
      <p className="muted">Used to sign in and to unlock the Console. {changedAt ? `Last changed ${new Date(changedAt).toLocaleString()}.` : changedAt === null ? 'Still the password generated at install — change it.' : ''}</p>
      <label className="field"><span>Current password</span>
        <input type="password" autoComplete="current-password" value={f.current} onChange={set('current')} required /></label>
      <div className="row">
        <label className="field"><span>New password (12+ characters)</span>
          <input type="password" autoComplete="new-password" value={f.next} onChange={set('next')} required /></label>
        <label className="field"><span>New password again</span>
          <input type="password" autoComplete="new-password" value={f.again} onChange={set('again')} required /></label>
      </div>
      <div className="save-row">
        <button type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
        {msg && <span className={msg.bad ? 'bad-text' : 'saved'}>{msg.text}</span>}
      </div>
    </form>
  );
}

export default function Settings() {
  const [rules, setRules] = useState(null);
  const [email, setEmail] = useState(null);
  const [smtpPass, setSmtpPass] = useState('');
  const [saved, setSaved] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [uptime, setUptime] = useState(null);
  const [digest, setDigest] = useState(null);
  const [digestMsg, setDigestMsg] = useState('');

  useEffect(() => {
    api.digest().then((d) => setDigest({ daily: d.daily, weekly: d.weekly, hour: d.hour, weekday: d.weekday, timeZone: d.timeZone, lastDaily: d.lastDaily, lastWeekly: d.lastWeekly })).catch(() => {});
    api.getSettings().then((s) => {
      setRules({ siteDown: { enabled: true, failures: 2, remindMinutes: 30 }, sslExpiry: { enabled: true, days: 14, remindMinutes: 1440 }, newPublicPort: { enabled: true }, sshBruteForce: { enabled: true, perHour: 1000, remindMinutes: 360 }, sshLogin: { enabled: false }, ...(s.alertRules || {}) });
      const u = s.uptime || {};
      setUptime({
        intervalSeconds: u.intervalSeconds ?? 60, timeoutSeconds: u.timeoutSeconds ?? 10,
        extraUrls: (u.extraUrls || []).join('\n'), tlsEndpoints: (u.tlsEndpoints || []).join('\n'), ignore: (u.ignore || []).join('\n'),
      });
      const em = (s.receivers && s.receivers.email) || {};
      setEmail({
        enabled: !!em.enabled,
        to: (em.to || []).join(', '),
        from: em.from || '',
        smtp: { host: '', port: 587, user: '', ...(em.smtp || {}) },
      });
    }).catch(() => {});
  }, []);

  if (!rules || !email || !uptime || !digest) return (<><Header active="/settings" sub="settings" /><main className="wrap"><div className="panel">Loading…</div></main></>);

  function setRule(key, field, value) {
    setRules((r) => ({ ...r, [key]: { ...r[key], [field]: value } }));
  }
  function setSmtp(field, value) {
    setEmail((e) => ({ ...e, smtp: { ...e.smtp, [field]: value } }));
  }

  async function save(e) {
    e.preventDefault();
    const patch = {
      alertRules: rules,
      uptime: {
        intervalSeconds: Number(uptime.intervalSeconds), timeoutSeconds: Number(uptime.timeoutSeconds),
        extraUrls: uptime.extraUrls, tlsEndpoints: uptime.tlsEndpoints, ignore: uptime.ignore,
      },
      digest: { daily: digest.daily, weekly: digest.weekly, hour: Number(digest.hour), weekday: Number(digest.weekday), timeZone: digest.timeZone },
      receivers: {
        email: {
          enabled: email.enabled,
          to: email.to.split(',').map((x) => x.trim()).filter(Boolean),
          from: email.from,
          smtp: {
            host: email.smtp.host,
            port: Number(email.smtp.port) || 587,
            secure: !!email.smtp.secure,
            user: email.smtp.user,
            pass: smtpPass, // blank = keep stored
          },
        },
      },
    };
    await api.saveSettings(patch);
    setSmtpPass('');
    setSaved('Saved ✓');
    setTimeout(() => setSaved(''), 2500);
  }

  async function sendTest() {
    setTestMsg('Sending…');
    try {
      const r = await api.testEmail();
      setTestMsg(r.ok ? 'Test email sent ✓' : `Failed: ${r.reason || 'check SMTP settings'}`);
    } catch (e) {
      setTestMsg(`Failed: ${e.message}`);
    }
  }

  return (
    <>
      <Header active="/settings" sub="settings" />
      <main className="wrap">
        <PasswordCard />
        <form onSubmit={save}>
          <section className="panel form-card">
            <h2>Alert thresholds</h2>
            <p className="muted">Fire an alert when a metric crosses its threshold.</p>
            {RULES.map(([key, label]) => {
              const r = rules[key] || {};
              return (
                <div className="rule-row" key={key}>
                  <label className="toggle">
                    <input type="checkbox" checked={!!r.enabled} onChange={(e) => setRule(key, 'enabled', e.target.checked)} />
                    <span>{label}</span>
                  </label>
                  <label className="field">
                    <span>Threshold</span>
                    <input type="number" value={r.threshold ?? ''} onChange={(e) => setRule(key, 'threshold', Number(e.target.value))} />
                  </label>
                  <label className="field">
                    <span>Remind every (min)</span>
                    <input type="number" value={r.remindMinutes ?? ''} onChange={(e) => setRule(key, 'remindMinutes', Number(e.target.value))} />
                  </label>
                </div>
              );
            })}
          </section>

          <section className="panel form-card">
            <h2>Uptime &amp; certificates</h2>
            <p className="muted">Every site in the nginx config is checked automatically (public URL + its app). Add other URLs or TLS ports below.</p>
            <div className="rule-row">
              <label className="toggle">
                <input type="checkbox" checked={!!rules.siteDown.enabled} onChange={(e) => setRule('siteDown', 'enabled', e.target.checked)} />
                <span>Site down</span>
              </label>
              <label className="field"><span>After failed checks</span>
                <input type="number" min="1" value={rules.siteDown.failures ?? ''} onChange={(e) => setRule('siteDown', 'failures', Number(e.target.value))} /></label>
              <label className="field"><span>Remind every (min)</span>
                <input type="number" value={rules.siteDown.remindMinutes ?? ''} onChange={(e) => setRule('siteDown', 'remindMinutes', Number(e.target.value))} /></label>
            </div>
            <div className="rule-row">
              <label className="toggle">
                <input type="checkbox" checked={!!rules.sslExpiry.enabled} onChange={(e) => setRule('sslExpiry', 'enabled', e.target.checked)} />
                <span>Certificate expiry</span>
              </label>
              <label className="field"><span>Days left ≤</span>
                <input type="number" min="1" value={rules.sslExpiry.days ?? ''} onChange={(e) => setRule('sslExpiry', 'days', Number(e.target.value))} /></label>
              <label className="field"><span>Remind every (min)</span>
                <input type="number" value={rules.sslExpiry.remindMinutes ?? ''} onChange={(e) => setRule('sslExpiry', 'remindMinutes', Number(e.target.value))} /></label>
            </div>
            <div className="row">
              <label className="field"><span>Check every (s)</span>
                <input type="number" min="30" value={uptime.intervalSeconds} onChange={(e) => setUptime({ ...uptime, intervalSeconds: e.target.value })} /></label>
              <label className="field"><span>Timeout (s)</span>
                <input type="number" min="2" max="30" value={uptime.timeoutSeconds} onChange={(e) => setUptime({ ...uptime, timeoutSeconds: e.target.value })} /></label>
            </div>
            <label className="field"><span>Extra URLs (one per line)</span>
              <textarea rows={3} value={uptime.extraUrls} placeholder="https://example.com/health" onChange={(e) => setUptime({ ...uptime, extraUrls: e.target.value })} /></label>
            <label className="field"><span>Extra TLS endpoints, host:port (certificate only)</span>
              <textarea rows={2} value={uptime.tlsEndpoints} placeholder="turn.example.com:5349" onChange={(e) => setUptime({ ...uptime, tlsEndpoints: e.target.value })} /></label>
            <label className="field"><span>Ignored (one per line; also toggled from the Uptime page)</span>
              <textarea rows={2} value={uptime.ignore} onChange={(e) => setUptime({ ...uptime, ignore: e.target.value })} /></label>
          </section>

          <section className="panel form-card">
            <h2>Email digest</h2>
            <p className="muted">A summary email: server, sites, alerts, apps and security. On the weekly day only the weekly one is sent.</p>
            <label className="toggle">
              <input type="checkbox" checked={digest.daily} onChange={(e) => setDigest({ ...digest, daily: e.target.checked })} />
              <span>Daily report (last 24 h)</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={digest.weekly} onChange={(e) => setDigest({ ...digest, weekly: e.target.checked })} />
              <span>Weekly report (last 7 days)</span>
            </label>
            <div className="row">
              <label className="field"><span>Send at (hour, 0–23)</span>
                <input type="number" min="0" max="23" value={digest.hour} onChange={(e) => setDigest({ ...digest, hour: e.target.value })} /></label>
              <label className="field"><span>Weekly on</span>
                <select value={digest.weekday} onChange={(e) => setDigest({ ...digest, weekday: Number(e.target.value) })}>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select></label>
              <label className="field"><span>Time zone</span>
                <input type="text" value={digest.timeZone} placeholder="Asia/Ho_Chi_Minh" onChange={(e) => setDigest({ ...digest, timeZone: e.target.value })} /></label>
            </div>
            <div className="test-row">
              <a className="button-link secondary" href="/api/digest/preview?period=daily" target="_blank" rel="noreferrer">Preview daily</a>
              <a className="button-link secondary" href="/api/digest/preview?period=weekly" target="_blank" rel="noreferrer">Preview weekly</a>
              <button type="button" className="secondary" onClick={async () => {
                setDigestMsg('Sending…');
                try { const r = await api.digestSend('daily'); setDigestMsg(`Sent ✓ "${r.subject}"`); } catch (e) { setDigestMsg(`Failed: ${e.message}`); }
              }}>Send daily now</button>
              <span className="muted">{digestMsg || `Last sent: daily ${digest.lastDaily || '—'}, weekly ${digest.lastWeekly || '—'}`}</span>
            </div>
          </section>

          <section className="panel form-card">
            <h2>Security alerts</h2>
            <p className="muted">From the Security page checks (read-only).</p>
            <label className="toggle">
              <input type="checkbox" checked={!!rules.newPublicPort.enabled} onChange={(e) => setRule('newPublicPort', 'enabled', e.target.checked)} />
              <span>A new port opens to the internet</span>
            </label>
            <div className="rule-row">
              <label className="toggle">
                <input type="checkbox" checked={!!rules.sshBruteForce.enabled} onChange={(e) => setRule('sshBruteForce', 'enabled', e.target.checked)} />
                <span>SSH brute force</span>
              </label>
              <label className="field"><span>Failed logins per hour ≥</span>
                <input type="number" min="10" value={rules.sshBruteForce.perHour ?? ''} onChange={(e) => setRule('sshBruteForce', 'perHour', Number(e.target.value))} /></label>
              <label className="field"><span>Remind every (min)</span>
                <input type="number" value={rules.sshBruteForce.remindMinutes ?? ''} onChange={(e) => setRule('sshBruteForce', 'remindMinutes', Number(e.target.value))} /></label>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={!!rules.sshLogin.enabled} onChange={(e) => setRule('sshLogin', 'enabled', e.target.checked)} />
              <span>Email me on every successful SSH login</span>
            </label>
          </section>

          <section className="panel form-card">
            <h2>Email alerts</h2>
            <label className="toggle">
              <input type="checkbox" checked={email.enabled} onChange={(e) => setEmail({ ...email, enabled: e.target.checked })} />
              <span>Send alerts by email</span>
            </label>
            <label className="field">
              <span>Send to (comma-separated)</span>
              <input type="text" value={email.to} placeholder="you@omranisystems.com" onChange={(e) => setEmail({ ...email, to: e.target.value })} />
            </label>
            <label className="field">
              <span>From</span>
              <input type="text" value={email.from} placeholder="monitoring@omranisystems.com" onChange={(e) => setEmail({ ...email, from: e.target.value })} />
            </label>
            <div className="row">
              <label className="field"><span>SMTP host</span>
                <input type="text" value={email.smtp.host} onChange={(e) => setSmtp('host', e.target.value)} /></label>
              <label className="field"><span>Port</span>
                <input type="number" value={email.smtp.port} onChange={(e) => setSmtp('port', e.target.value)} /></label>
            </div>
            <div className="row">
              <label className="field"><span>SMTP user</span>
                <input type="text" value={email.smtp.user} onChange={(e) => setSmtp('user', e.target.value)} /></label>
              <label className="field"><span>SMTP password</span>
                <input type="password" value={smtpPass} placeholder="leave blank to keep" onChange={(e) => setSmtpPass(e.target.value)} /></label>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={!!email.smtp.secure} onChange={(e) => setSmtp('secure', e.target.checked)} />
              <span>Use TLS (port 465)</span>
            </label>
            <div className="test-row">
              <button type="button" className="secondary" onClick={sendTest}>Send test email</button>
              <span className="muted">{testMsg}</span>
            </div>
          </section>

          <div className="save-row">
            <button type="submit">Save settings</button>
            <span className="saved">{saved}</span>
          </div>
        </form>
      </main>
    </>
  );
}
