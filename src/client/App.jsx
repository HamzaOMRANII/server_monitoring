import { usePath } from './router.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Settings from './pages/Settings.jsx';
import Logs from './pages/Logs.jsx';
import Uptime from './pages/Uptime.jsx';
import Alerts from './pages/Alerts.jsx';
import AppDetail from './pages/AppDetail.jsx';

// Ambient background — same petrol/blue orbs + noise as it.omranisystems.com.
function Background() {
  return (
    <div className="bg-field" aria-hidden="true">
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="noise" />
    </div>
  );
}

export default function App() {
  const path = usePath();

  if (path === '/login') {
    return (
      <>
        <Background />
        <Login />
      </>
    );
  }

  return (
    <>
      <Background />
      {path === '/settings' ? <Settings /> : path === '/logs' ? <Logs /> : path === '/uptime' ? <Uptime /> : path === '/alerts' ? <Alerts /> : path.startsWith('/apps/') ? <AppDetail name={decodeURIComponent(path.slice(6))} /> : <Dashboard />}
    </>
  );
}
