import { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';

interface User {
  email: string;
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    const timeout = setTimeout(() => setUser(null), 8_000); // fallback: show login after 8s
    fetch('/api/auth/session')
      .then(r => {
        clearTimeout(timeout);
        if (r.status === 401) return setUser(null);
        if (!r.ok) return setUser(null); // 5xx — treat as logged out rather than hang
        return r.json().then((d: { user?: User }) => setUser(d.user ?? null));
      })
      .catch(() => { clearTimeout(timeout); setUser(null); });
  }, []);

  if (user === undefined) return <div style={{ color: '#8b949e', padding: 20 }}>Loading...</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}
