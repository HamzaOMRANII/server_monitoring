import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go } from '../router.js';

function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="w-it">mon</span><span className="w-light">itoring</span>
        <span className="brand-sub">settings</span>
      </div>
      <nav>
        <a href="/" onClick={go('/')}>Dashboard</a>
        <a href="/uptime" onClick={go('/uptime')}>Uptime</a>
        <a href="/logs" onClick={go('/logs')}>Logs</a>
        <a href="/settings" className="active" onClick={go('/settings')}>Settings</a>
        <a href="/login" onClick={async (e) => { e.preventDefault(); await api.logout(); go('/login')(); }}>Sign out</a>
      </nav>
    </header>
  );
}

const RULES = [
  ['cpuPercent', 'CPU %'],
  ['memPercent', 'RAM %'],
  ['diskPercent', 'Disk %'],
];

export default function Settings() {
  const [rules, setRules] = useState(null);
  const [email, setEmail] = useState(null);
  const [smtpPass, setSmtpPass] = useState('');
  const [saved, setSaved] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [uptime, setUptime] = useState(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setRules({ siteDown: { enabled: true, failures: 2, remindMinutes: 30 }, sslExpiry: { enabled: true, days: 14, remindMinutes: 1440 }, ...(s.alertRules || {}) });
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

  if (!rules || !email || !uptime) return (<><Header /><main className="wrap"><div className="panel">Loading…</div></main></>);

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
      <Header />
      <main className="wrap">
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
