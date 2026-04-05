import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './api';

interface User {
  email: string;
}

interface HealthData {
  status?: string;
  uptime?: number;
  [key: string]: unknown;
}

interface StatusData {
  quoting?: boolean;
  state?: string;
  [key: string]: unknown;
}

interface PnlData {
  totalRealizedPnl?: number;
  fillCount?: number;
  [key: string]: unknown;
}

interface Fill {
  time?: string;
  timestamp?: string;
  side?: string;
  price?: number;
  qty?: number;
  quantity?: number;
  [key: string]: unknown;
}

interface FillsData {
  fills?: Fill[];
  data?: Fill[];
}

interface LogsData {
  lines?: string[];
  logs?: string[];
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function formatTime(ts: string | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

const cardStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #21262d',
  borderRadius: 8,
  padding: 20,
  marginBottom: 16,
};

const headingStyle: React.CSSProperties = {
  color: '#58a6ff',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 12,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
};

const labelStyle: React.CSSProperties = { color: '#8b949e', fontSize: 12 };
const valueStyle: React.CSSProperties = { color: '#e6edf3', fontSize: 14 };

export default function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [pnl, setPnl] = useState<PnlData | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const cancelledRef = useRef(false);

  const fetchAll = useCallback(async () => {
    const [h, s, p, f, l] = await Promise.allSettled([
      api.health(),
      api.status(),
      api.pnl('?limit=1'),
      api.fills('?limit=10'),
      api.logsTail(20),
    ]);

    if (h.status === 'fulfilled') setHealth(h.value as HealthData);
    if (s.status === 'fulfilled') setStatus(s.value as StatusData);
    if (p.status === 'fulfilled') setPnl(p.value as PnlData);
    if (f.status === 'fulfilled') {
      const fd = f.value as FillsData;
      setFills(fd.fills ?? fd.data ?? []);
    }
    if (l.status === 'fulfilled') {
      const ld = l.value as LogsData;
      setLogs(ld.lines ?? ld.logs ?? []);
    }

    // Only update timestamp if at least one fetch succeeded
    const anyFulfilled = [h, s, p, f, l].some(r => r.status === 'fulfilled');
    if (anyFulfilled) setLastUpdated(new Date());

    // Log out on 401
    const anyUnauthorized = [h, s, p, f, l].some(
      r => r.status === 'rejected' && r.reason instanceof Error && r.reason.message === 'unauthorized'
    );
    if (anyUnauthorized) onLogout();
  }, [onLogout]);

  useEffect(() => {
    cancelledRef.current = false;

    // Serialized poll loop — waits for each fetch to complete before scheduling next
    const poll = async () => {
      while (!cancelledRef.current) {
        await fetchAll();
        await new Promise(r => setTimeout(r, 10_000));
      }
    };
    poll();

    return () => { cancelledRef.current = true; };
  }, [fetchAll]);

  async function handleLogout() {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        console.error('[logout] failed:', res.status);
        return;
      }
    } catch (err) {
      console.error('[logout] network error:', err);
      return;
    }
    onLogout();
  }

  const quotingColor = status?.quoting ? '#3fb950' : '#f85149';
  const healthColor = health?.status === 'ok' || health?.status === 'healthy' ? '#3fb950' : '#f85149';
  const pnlValue = pnl?.totalRealizedPnl ?? 0;
  const pnlColor = pnlValue >= 0 ? '#3fb950' : '#f85149';

  return (
    <div style={{ minHeight: '100vh', background: '#0d1117', padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ color: '#58a6ff', fontSize: 18, fontFamily: 'monospace' }}>TrueX Market Maker</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {lastUpdated && (
            <span style={{ color: '#8b949e', fontSize: 12 }}>
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <span style={{ color: '#8b949e', fontSize: 13 }}>{user.email}</span>
          <button
            onClick={handleLogout}
            style={{ background: 'transparent', border: '1px solid #30363d', borderRadius: 4, color: '#8b949e', padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}
          >
            Logout
          </button>
        </div>
      </div>

      {/* Top row: Status + PnL */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 0 }}>
        <div style={cardStyle}>
          <div style={headingStyle}>System Status</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={labelStyle}>Health</span>
              <span style={{ ...valueStyle, color: healthColor }}>{health?.status ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={labelStyle}>Quoting</span>
              <span style={{ ...valueStyle, color: quotingColor }}>
                {status?.quoting !== undefined ? (status.quoting ? 'Active' : 'Inactive') : '—'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={labelStyle}>State</span>
              <span style={valueStyle}>{status?.state ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={labelStyle}>Uptime</span>
              <span style={valueStyle}>
                {health?.uptime !== undefined ? formatUptime(health.uptime) : '—'}
              </span>
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={headingStyle}>P&amp;L Summary</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={labelStyle}>Realized PnL</span>
              <span style={{ ...valueStyle, color: pnlColor, fontSize: 18, fontWeight: 600 }}>
                {pnl ? `${pnlValue >= 0 ? '+' : ''}${pnlValue.toFixed(4)}` : '—'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={labelStyle}>Fill Count</span>
              <span style={valueStyle}>{pnl?.fillCount ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Fills */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={headingStyle}>Recent Fills</div>
        {fills.length === 0 ? (
          <div style={{ color: '#8b949e', fontSize: 13 }}>No fills yet</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Time', 'Side', 'Price', 'Qty'].map(col => (
                  <th key={col} style={{ color: '#8b949e', textAlign: 'left', paddingBottom: 8, fontWeight: 400, borderBottom: '1px solid #21262d' }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fills.slice(0, 10).map((fill, i) => {
                const side = fill.side?.toUpperCase();
                const sideColor = side === 'BUY' ? '#3fb950' : side === 'SELL' ? '#f85149' : '#e6edf3';
                return (
                  <tr key={i}>
                    <td style={{ color: '#8b949e', padding: '6px 0', borderBottom: '1px solid #161b22' }}>
                      {formatTime(fill.time ?? fill.timestamp)}
                    </td>
                    <td style={{ color: sideColor, padding: '6px 0', borderBottom: '1px solid #161b22' }}>
                      {side ?? '—'}
                    </td>
                    <td style={{ color: '#e6edf3', padding: '6px 0', borderBottom: '1px solid #161b22' }}>
                      {fill.price != null ? fill.price.toFixed(2) : '—'}
                    </td>
                    <td style={{ color: '#e6edf3', padding: '6px 0', borderBottom: '1px solid #161b22' }}>
                      {(fill.qty ?? fill.quantity) != null ? (fill.qty ?? fill.quantity) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Log Tail */}
      <div style={cardStyle}>
        <div style={headingStyle}>Log Tail</div>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 4, padding: 12, maxHeight: 300, overflowY: 'auto' }}>
          {logs.length === 0 ? (
            <div style={{ color: '#8b949e', fontSize: 12 }}>No logs</div>
          ) : (
            logs.map((line, idx) => (
              <div key={idx} style={{ color: '#8b949e', fontSize: 11, lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
