import { createClearAuth, handleClearAuthEdgeRequest, createMechKysely, createSessionCookie } from 'clearauth/edge';

const AUTH_SENDER_EMAIL = 'auth@derivative.email';

// Magic-link tokens are single-use and short-lived.
const MAGIC_LINK_TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const MAGIC_LINK_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends per user
const SESSION_EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface Env {
  AUTH_SECRET: string;
  MECH_APP_ID: string;
  MECH_API_KEY: string;
  BASE_URL: string;
  CIRCLEINBOX_API_KEY?: string; // required for magic-link / reset emails
}

// Minimal email-provider shape (clearauth's EmailProvider type is not exported in 0.7.0).
interface EmailProvider {
  name: string;
  send(to: string, subject: string, html: string, text: string): Promise<void>;
}

function createCircleInboxProvider(apiKey: string, from: string): EmailProvider {
  return {
    name: 'circleinbox',
    async send(to: string, subject: string, html: string, text: string): Promise<void> {
      const resp = await fetch('https://api.circleinbox.com/api/v1/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: { email: from, name: 'TrueX Dashboard' }, to, subject, html, text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`CircleInbox send failed: ${resp.status} ${body}`);
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function randomToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type Db = ReturnType<typeof createMechKysely>;

/**
 * clearauth 0.7.0 ships magic-link logic but does not export it (not via `clearauth/edge`,
 * not via the package index, and the file path is blocked by the exports map), and its edge
 * request handler never routes /auth/request-magic-link. We implement the request + verify
 * flow directly against the same magic_link_tokens / sessions / users tables.
 */
export async function handleRequestMagicLink(request: Request, db: Db, env: Env): Promise<Response> {
  let email = '';
  try {
    const body = (await request.json()) as { email?: string };
    email = normalizeEmail(body.email ?? '');
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (!email) return json({ error: 'Email is required' }, 400);

  if (!env.CIRCLEINBOX_API_KEY) {
    console.error('[auth] request-magic-link: CIRCLEINBOX_API_KEY not configured');
    return json({ error: 'Email delivery is not configured' }, 503);
  }

  // Look up user. Return success regardless to prevent email enumeration.
  const user = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', email)
    .executeTakeFirst();

  if (user) {
    // Per-email cooldown: if the most recent token was issued within the cooldown window, do
    // not send another email. Bounds spam/DoS via this public endpoint. Stays
    // enumeration-safe by returning the same success response either way.
    const latest = await db
      .selectFrom('magic_link_tokens')
      .select(['expires_at'])
      .where('user_id', '=', user.id)
      .orderBy('expires_at', 'desc')
      .executeTakeFirst();
    if (latest) {
      const issuedAtMs = new Date(latest.expires_at as string | number | Date).getTime() - MAGIC_LINK_TOKEN_EXPIRY_MS;
      if (Date.now() - issuedAtMs < MAGIC_LINK_RESEND_COOLDOWN_MS) {
        return json({ success: true });
      }
    }

    // Insert-only (no delete-then-insert): concurrent requests can't race to revoke each
    // other's freshly-issued token. Multiple short-lived tokens per user are fine because
    // each is single-use — consumption is atomic in verify (DELETE ... RETURNING).
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TOKEN_EXPIRY_MS);
    await db
      .insertInto('magic_link_tokens')
      .values({ token, user_id: user.id, email, return_to: '/', expires_at: expiresAt })
      .execute();

    const linkUrl = `${env.BASE_URL}/api/auth/magic-link/verify?token=${token}`;
    const provider = createCircleInboxProvider(env.CIRCLEINBOX_API_KEY, AUTH_SENDER_EMAIL);
    const html = `<p>Click to sign in to the TrueX Market Maker dashboard:</p>
<p><a href="${linkUrl}">Sign in</a></p>
<p>This link expires in 15 minutes. If you did not request it, ignore this email.</p>`;
    const text = `Sign in to the TrueX Market Maker dashboard:\n${linkUrl}\n\nThis link expires in 15 minutes.`;
    try {
      await provider.send(email, 'Your TrueX dashboard sign-in link', html, text);
    } catch (err) {
      // Delivery failed — remove the token we just issued so the account isn't left with a
      // revoked old link and an undelivered new one. Log internally but return the SAME generic
      // success below as the unknown-user path, so a transient mail failure can't be used to
      // probe which emails are registered.
      console.error('[auth] magic-link email send failed:', err);
      await db.deleteFrom('magic_link_tokens').where('token', '=', token).execute();
    }
  }

  return json({ success: true });
}

/**
 * GET renders a tiny confirmation page that POSTs back the token; only the POST consumes it.
 * This prevents mail-client / security-scanner link prefetching (GET-only) from burning the
 * one-time token before the user actually clicks.
 */
function magicLinkConfirmPage(token: string): Response {
  const action = `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Sign in</title><style>body{background:#0d1117;color:#e6edf3;font-family:monospace;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}.c{background:#161b22;border:1px solid #21262d;
border-radius:8px;padding:32px;text-align:center}button{background:#1f6feb;border:none;border-radius:4px;color:#fff;
padding:10px 24px;font-size:14px;cursor:pointer;margin-top:16px}</style></head>
<body><div class="c"><h1 style="color:#58a6ff;font-size:18px">TrueX Market Maker</h1>
<p>Click to finish signing in.</p>
<form method="POST" action="${action}"><button type="submit">Sign in</button></form></div></body></html>`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function handleMagicLinkVerify(request: Request, db: Db, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const loginUrl = `${env.BASE_URL}/`;

  const fail = (reason: string) =>
    Response.redirect(`${loginUrl}?error=${encodeURIComponent(reason)}`, 302);

  if (!token) return fail('Missing token');

  // Non-destructive GET: show the confirm page without touching the token.
  if (request.method === 'GET') return magicLinkConfirmPage(token);

  // Login-CSRF guard: the consume step is a state-changing POST that sets a session cookie.
  // Our confirm page posts same-origin (browsers always send Origin cross-site), so reject any
  // POST whose Origin doesn't match this app — prevents a third-party page from forcing a
  // victim's browser to redeem an attacker-controlled token into the victim's session.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(env.BASE_URL).origin) return fail('Invalid request origin');

  // Atomic single-use consumption: DELETE ... RETURNING means only one concurrent POST can
  // win the row, so a token can never mint two sessions.
  const tokenRecord = await db
    .deleteFrom('magic_link_tokens')
    .where('token', '=', token)
    .returningAll()
    .executeTakeFirst();

  if (!tokenRecord) return fail('Invalid or expired link');

  if (new Date(tokenRecord.expires_at as string | number | Date) <= new Date()) {
    return fail('Link has expired');
  }

  // From here the token is already claimed. If a later step fails transiently, re-insert it so
  // a server-side error doesn't permanently burn the user's link.
  const restoreToken = async () => {
    await db.insertInto('magic_link_tokens').values({
      token: tokenRecord.token,
      user_id: tokenRecord.user_id,
      email: tokenRecord.email,
      return_to: tokenRecord.return_to,
      expires_at: tokenRecord.expires_at,
    }).execute();
  };

  let sessionId: string;
  try {
    const user = await db
      .selectFrom('users')
      .select(['id', 'email_verified'])
      .where('id', '=', tokenRecord.user_id)
      .executeTakeFirst();
    if (!user) return fail('User not found');

    // Clicking the link proves email ownership.
    if (!user.email_verified) {
      await db.updateTable('users').set({ email_verified: true }).where('id', '=', user.id).execute();
    }

    // Create a server-side session and set the same cookie the rest of the app reads.
    sessionId = randomToken(25);
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_SECONDS * 1000);
    await db
      .insertInto('sessions')
      .values({
        id: sessionId,
        user_id: user.id,
        expires_at: expiresAt,
        ip_address: request.headers.get('CF-Connecting-IP') ?? null,
        user_agent: request.headers.get('User-Agent') ?? null,
      })
      .execute();
  } catch (err) {
    console.error('[auth] magic-link session creation failed:', err);
    await restoreToken().catch(() => {});
    return fail('Could not complete sign-in, please try again');
  }

  const cookie = createSessionCookie(sessionId, {
    isProduction: true,
    session: { expiresIn: SESSION_EXPIRY_SECONDS },
  });

  const returnTo = (tokenRecord.return_to as string) || '/';
  return new Response(null, {
    status: 302,
    headers: { Location: `${env.BASE_URL}${returnTo.startsWith('/') ? returnTo : '/'}`, 'Set-Cookie': cookie },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { AUTH_SECRET, BASE_URL, MECH_APP_ID, MECH_API_KEY, CIRCLEINBOX_API_KEY } = context.env;

  if (!AUTH_SECRET || !BASE_URL || !MECH_APP_ID || !MECH_API_KEY) {
    console.error('[auth] Missing required env vars: AUTH_SECRET, BASE_URL, MECH_APP_ID, MECH_API_KEY');
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Magic-link routes are handled here because clearauth 0.7.0's edge handler does not route them.
  const url = new URL(context.request.url);
  if (url.pathname === '/api/auth/request-magic-link' && context.request.method === 'POST') {
    const db = createMechKysely({ appId: MECH_APP_ID, apiKey: MECH_API_KEY });
    return handleRequestMagicLink(context.request, db, context.env);
  }
  if (url.pathname === '/api/auth/magic-link/verify' && (context.request.method === 'GET' || context.request.method === 'POST')) {
    const db = createMechKysely({ appId: MECH_APP_ID, apiKey: MECH_API_KEY });
    return handleMagicLinkVerify(context.request, db, context.env);
  }

  const config = createClearAuth({
    secret: AUTH_SECRET,
    baseUrl: BASE_URL,
    database: {
      appId: MECH_APP_ID,
      apiKey: MECH_API_KEY,
    },
    isProduction: true,
    ...(CIRCLEINBOX_API_KEY && {
      email: {
        provider: createCircleInboxProvider(CIRCLEINBOX_API_KEY, AUTH_SENDER_EMAIL),
        from: AUTH_SENDER_EMAIL,
      },
    }),
  });

  return handleClearAuthEdgeRequest(context.request, config);
};
