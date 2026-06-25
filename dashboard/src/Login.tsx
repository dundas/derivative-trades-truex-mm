import { useState, useEffect } from 'react';

interface User {
  email: string;
}

interface LoginResponse {
  user?: User;
  error?: string;
}

type Mode = 'password' | 'magic';

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  // The magic-link verifier redirects back to /?error=... when a link is invalid or expired.
  // Surface that message, then strip it from the URL so it doesn't persist on refresh.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) {
      setError(err);
      params.delete('error');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, []);

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      // Parse JSON defensively — body may be empty or non-JSON on some errors
      let data: LoginResponse = {};
      try {
        const text = await res.text();
        if (text) data = JSON.parse(text) as LoginResponse;
      } catch {
        // ignore parse error — fall through to generic error
      }

      if (!res.ok) throw new Error(data.error || 'Login failed');
      if (!data.user) throw new Error('Login failed: no user returned');
      onLogin(data.user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  // Magic-link sign-in: send an email with a one-time login link, then show confirmation.
  async function handleEmailLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/request-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      let data: LoginResponse = {};
      try {
        const text = await res.text();
        if (text) data = JSON.parse(text) as LoginResponse;
      } catch {
        // ignore parse error
      }
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setSent(false);
    setPassword('');
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 4,
    color: '#e6edf3',
    padding: '8px 12px',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const linkStyle: React.CSSProperties = {
    color: '#58a6ff',
    fontSize: 12,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    textDecoration: 'underline',
  };

  const submitStyle: React.CSSProperties = {
    width: '100%',
    background: '#1f6feb',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    padding: '10px',
    fontSize: 14,
    cursor: 'pointer',
  };

  function tabStyle(active: boolean): React.CSSProperties {
    return {
      flex: 1,
      background: 'none',
      border: 'none',
      borderBottom: active ? '2px solid #58a6ff' : '2px solid transparent',
      color: active ? '#e6edf3' : '#8b949e',
      padding: '8px 0',
      fontSize: 13,
      cursor: 'pointer',
    };
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0d1117', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 8, padding: 32, width: 360 }}>
        <h1 style={{ color: '#58a6ff', fontSize: 18, marginBottom: 24, fontFamily: 'monospace' }}>TrueX Market Maker</h1>

        {sent ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📬</div>
            <div style={{ color: '#e6edf3', fontSize: 16, marginBottom: 8 }}>Check your email</div>
            <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 24 }}>
              We sent a link to <strong style={{ color: '#e6edf3' }}>{email}</strong>
            </div>
            {error && <div style={{ color: '#f85149', fontSize: 13, marginBottom: 16 }}>{error}</div>}
            <button onClick={() => handleEmailLink({ preventDefault: () => {} } as React.FormEvent)} disabled={loading} style={submitStyle}>
              {loading ? 'Sending...' : 'Send again'}
            </button>
            <div style={{ marginTop: 16 }}>
              <button onClick={() => switchMode('password')} style={linkStyle}>Back to sign in</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', marginBottom: 20 }}>
              <button onClick={() => switchMode('password')} style={tabStyle(mode === 'password')}>Password</button>
              <button onClick={() => switchMode('magic')} style={tabStyle(mode === 'magic')}>Email link</button>
            </div>

            {mode === 'password' ? (
              <form onSubmit={handlePasswordLogin}>
                <div style={{ marginBottom: 16 }}>
                  <label htmlFor="email" style={{ color: '#8b949e', fontSize: 12, display: 'block', marginBottom: 4 }}>EMAIL</label>
                  <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required style={inputStyle} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label htmlFor="password" style={{ color: '#8b949e', fontSize: 12, display: 'block', marginBottom: 4 }}>PASSWORD</label>
                  <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required style={inputStyle} />
                </div>
                {error && <div style={{ color: '#f85149', fontSize: 13, marginBottom: 16 }}>{error}</div>}
                <button type="submit" disabled={loading} style={submitStyle}>{loading ? 'Signing in...' : 'Sign in'}</button>
              </form>
            ) : (
              <form onSubmit={handleEmailLink}>
                <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 16 }}>We'll email you a one-time sign-in link.</div>
                <div style={{ marginBottom: 16 }}>
                  <label htmlFor="email" style={{ color: '#8b949e', fontSize: 12, display: 'block', marginBottom: 4 }}>EMAIL</label>
                  <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required style={inputStyle} />
                </div>
                {error && <div style={{ color: '#f85149', fontSize: 13, marginBottom: 16 }}>{error}</div>}
                <button type="submit" disabled={loading} style={submitStyle}>{loading ? 'Sending...' : 'Send link'}</button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
