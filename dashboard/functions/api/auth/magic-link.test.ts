/**
 * Tests for the custom magic-link auth handlers.
 *
 * Uses an in-memory Kysely-shaped db mock and a stubbed global fetch (for the CircleInbox
 * send) so token issuance, cooldown, expiry, one-time consumption, session creation, and
 * failure redirects are exercised without a live database or email provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { handleRequestMagicLink, handleMagicLinkVerify } from './[[path]].ts';

// --- minimal in-memory Kysely-shaped mock -----------------------------------
function pick(row: Record<string, unknown>, cols: string[] | null) {
  if (!cols) return { ...row };
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

function makeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const t = tables;
  const selectFrom = (name: string) => {
    let cols: string[] | null = null;
    const conds: Array<[string, unknown]> = [];
    let order: [string, 'asc' | 'desc'] | null = null;
    const matches = () => {
      let rows = (t[name] || []).filter((r) => conds.every(([c, v]) => r[c] === v));
      if (order) {
        const [oc, dir] = order;
        rows = [...rows].sort((a, b) => {
          const av = new Date(a[oc] as any).getTime(), bv = new Date(b[oc] as any).getTime();
          return dir === 'desc' ? bv - av : av - bv;
        });
      }
      return rows;
    };
    const api = {
      select(c: string[]) { cols = c; return api; },
      selectAll() { cols = null; return api; },
      where(col: string, _op: string, val: unknown) { conds.push([col, val]); return api; },
      orderBy(col: string, dir: 'asc' | 'desc') { order = [col, dir]; return api; },
      async executeTakeFirst() { const r = matches()[0]; return r ? pick(r, cols) : undefined; },
      async execute() { return matches().map((r) => pick(r, cols)); },
    };
    return api;
  };
  return {
    selectFrom,
    insertInto: (name: string) => ({
      values(v: Record<string, unknown>) {
        return { async execute() { (t[name] = t[name] || []).push({ ...v }); } };
      },
    }),
    deleteFrom: (name: string) => {
      const conds: Array<[string, unknown]> = [];
      let returning = false;
      const api = {
        where(c: string, _op: string, v: unknown) { conds.push([c, v]); return api; },
        returningAll() { returning = true; return api; },
        async execute() { t[name] = (t[name] || []).filter((r) => !conds.every(([c, v]) => r[c] === v)); },
        async executeTakeFirst() {
          const hit = (t[name] || []).find((r) => conds.every(([c, v]) => r[c] === v));
          t[name] = (t[name] || []).filter((r) => !conds.every(([c, v]) => r[c] === v));
          return returning ? (hit ? { ...hit } : undefined) : undefined;
        },
      };
      return api;
    },
    updateTable: (name: string) => {
      let set: Record<string, unknown> = {};
      const conds: Array<[string, unknown]> = [];
      const api = {
        set(s: Record<string, unknown>) { set = s; return api; },
        where(c: string, _op: string, v: unknown) { conds.push([c, v]); return api; },
        async execute() {
          (t[name] || []).forEach((r) => { if (conds.every(([c, v]) => r[c] === v)) Object.assign(r, set); });
        },
      };
      return api;
    },
  } as any;
}

const ENV = { CIRCLEINBOX_API_KEY: 'test-key', BASE_URL: 'https://dash.test', AUTH_SECRET: 's', MECH_APP_ID: 'a', MECH_API_KEY: 'k' } as any;
const USER = { id: 'u1', email: 'user@x.com', email_verified: false };

let fetchCalls = 0;
const realFetch = globalThis.fetch;
beforeEach(() => { fetchCalls = 0; globalThis.fetch = (async () => { fetchCalls++; return new Response('{}', { status: 200 }); }) as any; });
afterEach(() => { globalThis.fetch = realFetch; });

const reqMagic = (email: string) =>
  new Request('https://dash.test/api/auth/request-magic-link', { method: 'POST', body: JSON.stringify({ email }) });

describe('handleRequestMagicLink', () => {
  it('issues a token and sends one email for a known user', async () => {
    const tables = { users: [{ ...USER }], magic_link_tokens: [] as any[], sessions: [] as any[] };
    const res = await handleRequestMagicLink(reqMagic('user@x.com'), makeDb(tables), ENV);
    expect(res.status).toBe(200);
    expect(tables.magic_link_tokens).toHaveLength(1);
    expect(fetchCalls).toBe(1);
  });

  it('does not reveal unknown users (no token, no email, still 200)', async () => {
    const tables = { users: [{ ...USER }], magic_link_tokens: [] as any[], sessions: [] as any[] };
    const res = await handleRequestMagicLink(reqMagic('nobody@x.com'), makeDb(tables), ENV);
    expect(res.status).toBe(200);
    expect(tables.magic_link_tokens).toHaveLength(0);
    expect(fetchCalls).toBe(0);
  });

  it('enforces a per-user cooldown (no second email while a fresh token exists)', async () => {
    const fresh = { token: 't0', user_id: 'u1', email: 'user@x.com', return_to: '/', expires_at: new Date(Date.now() + 14.9 * 60 * 1000) };
    const tables = { users: [{ ...USER }], magic_link_tokens: [fresh], sessions: [] as any[] };
    const res = await handleRequestMagicLink(reqMagic('user@x.com'), makeDb(tables), ENV);
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(0); // cooldown — no resend
    expect(tables.magic_link_tokens[0].token).toBe('t0'); // original token untouched
  });

  it('503s when email delivery is not configured', async () => {
    const tables = { users: [{ ...USER }], magic_link_tokens: [] as any[], sessions: [] as any[] };
    const res = await handleRequestMagicLink(reqMagic('user@x.com'), makeDb(tables), { ...ENV, CIRCLEINBOX_API_KEY: undefined });
    expect(res.status).toBe(503);
  });

  it('stays enumeration-safe on email delivery failure (generic 200, token rolled back)', async () => {
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as any;
    const tables = { users: [{ ...USER }], magic_link_tokens: [] as any[], sessions: [] as any[] };
    const res = await handleRequestMagicLink(reqMagic('user@x.com'), makeDb(tables), ENV);
    expect(res.status).toBe(200); // same as unknown-user path — does not reveal the failure
    expect(tables.magic_link_tokens).toHaveLength(0); // rolled back
  });
});

const verifyReq = (token: string, method: 'GET' | 'POST' = 'POST') =>
  new Request(`https://dash.test/api/auth/magic-link/verify?token=${token}`, { method });

describe('handleMagicLinkVerify', () => {
  it('GET is non-destructive: renders a confirm page without consuming the token', async () => {
    const tok = { token: 'good', user_id: 'u1', email: 'user@x.com', return_to: '/', expires_at: new Date(Date.now() + 5 * 60 * 1000) };
    const tables = { users: [{ ...USER }], magic_link_tokens: [tok], sessions: [] as any[] };
    const res = await handleMagicLinkVerify(verifyReq('good', 'GET'), makeDb(tables), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
    expect(tables.magic_link_tokens).toHaveLength(1); // NOT consumed by prefetch/GET
    expect(tables.sessions).toHaveLength(0);
  });

  it('POST consumes a valid token, creates a session, sets the cookie, and redirects', async () => {
    const tok = { token: 'good', user_id: 'u1', email: 'user@x.com', return_to: '/', expires_at: new Date(Date.now() + 5 * 60 * 1000) };
    const tables = { users: [{ ...USER }], magic_link_tokens: [tok], sessions: [] as any[] };
    const res = await handleMagicLinkVerify(verifyReq('good', 'POST'), makeDb(tables), ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie') ?? '').toContain('session=');
    expect(res.headers.get('Location')).toBe('https://dash.test/');
    expect(tables.sessions).toHaveLength(1);          // session created
    expect(tables.magic_link_tokens).toHaveLength(0); // one-time use
  });

  it('rejects an expired token and deletes it', async () => {
    const tok = { token: 'old', user_id: 'u1', email: 'user@x.com', return_to: '/', expires_at: new Date(Date.now() - 1000) };
    const tables = { users: [{ ...USER }], magic_link_tokens: [tok], sessions: [] as any[] };
    const res = await handleMagicLinkVerify(verifyReq('old', 'POST'), makeDb(tables), ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('error=');
    expect(tables.sessions).toHaveLength(0);
    expect(tables.magic_link_tokens).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    const tables = { users: [{ ...USER }], magic_link_tokens: [] as any[], sessions: [] as any[] };
    const res = await handleMagicLinkVerify(verifyReq('nope', 'POST'), makeDb(tables), ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('error=');
  });

  it('rejects a missing token', async () => {
    const tables = { users: [{ ...USER }], magic_link_tokens: [] as any[], sessions: [] as any[] };
    const res = await handleMagicLinkVerify(verifyReq('', 'POST'), makeDb(tables), ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('error=');
  });

  it('rejects a cross-site POST (login-CSRF) without consuming the token', async () => {
    const tok = { token: 'good', user_id: 'u1', email: 'user@x.com', return_to: '/', expires_at: new Date(Date.now() + 5 * 60 * 1000) };
    const tables = { users: [{ ...USER }], magic_link_tokens: [tok], sessions: [] as any[] };
    const req = new Request('https://dash.test/api/auth/magic-link/verify?token=good', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    const res = await handleMagicLinkVerify(req, makeDb(tables), ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('error=');
    expect(tables.magic_link_tokens).toHaveLength(1); // token untouched
    expect(tables.sessions).toHaveLength(0);
  });

  it('restores the token if session creation fails transiently', async () => {
    const tok = { token: 'good', user_id: 'u1', email: 'user@x.com', return_to: '/', expires_at: new Date(Date.now() + 5 * 60 * 1000) };
    const tables = { users: [{ ...USER }], magic_link_tokens: [tok], sessions: [] as any[] };
    const db = makeDb(tables);
    const realInsert = db.insertInto;
    db.insertInto = (name: string) =>
      name === 'sessions'
        ? { values: () => ({ async execute() { throw new Error('db down'); } }) }
        : realInsert(name);
    const res = await handleMagicLinkVerify(verifyReq('good', 'POST'), db, ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('error=');
    expect(tables.magic_link_tokens).toHaveLength(1); // re-inserted — link not burned
    expect(tables.sessions).toHaveLength(0);
  });
});
