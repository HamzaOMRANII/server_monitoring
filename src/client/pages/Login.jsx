import { useState } from 'react';
import { api } from '../api.js';
import { go } from '../router.js';

export default function Login() {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.login(password);
      go('/')();
    } catch {
      setErr('Incorrect password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="w-it">mon</span><span className="w-light">itoring</span>
        </div>
        <p className="domain"><span className="sep">//</span> omranisystems</p>
        <input
          type="password"
          placeholder="Dashboard password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="login-err">{err}</div>
      </form>
    </div>
  );
}
