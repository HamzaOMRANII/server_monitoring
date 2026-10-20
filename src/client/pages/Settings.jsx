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

  useEffect(() => {
    api.getSettings().then((s) => {
      setRules(s.alertRules || {});
      const em = (s.receivers && s.receivers.email) || {};
      setEmail({
        enabled: !!em.enabled,
        to: (em.to || []).join(', '),
        from: em.from || '',
        smtp: { host: '', port: 587, user: '', ...(em.smtp || {}) },
      });
    }).catch(() => {});
  }, []);

  if (!rules || !email) return (<><Header /><main className="wrap"><div className="panel">Loading…</div></main></>);

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
