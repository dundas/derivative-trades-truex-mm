const BASE = '/api/proxy';

async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export const api = {
  health: () => apiFetch('/api/v1/health'),
  status: () => apiFetch('/api/v1/stats'),
  pnl: (params = '') => apiFetch(`/api/v1/analytics/pnl${params}`),
  fills: (params = '') => apiFetch(`/api/v1/fills${params}`),
  sessions: () => apiFetch('/api/v1/sessions'),
  logsTail: (lines = 50) => apiFetch(`/api/v1/logs/tail?lines=${lines}`),
};
