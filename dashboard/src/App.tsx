import { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';

interface User {
  email: string;
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    fetch('/api/auth/session')
      .then(r => {
        if (r.status === 401) return setUser(null);
        if (!r.ok) return; // 5xx / network — don't log out, leave as loading
        return r.json().then((d: { user?: User }) => setUser(d.user ?? null));
      })
      .catch(() => {}); // network error — leave state as-is
  }, []);

  if (user === undefined) return <div style={{ color: '#8b949e', padding: 20 }}>Loading...</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}
