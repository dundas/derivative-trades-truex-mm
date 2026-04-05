import { createClearAuth, handleClearAuthEdgeRequest } from 'clearauth/edge';
import type { EmailProvider } from 'clearauth/edge';

const AUTH_SENDER_EMAIL = 'auth@derivative.email';

interface Env {
  AUTH_SECRET: string;
  MECH_APP_ID: string;
  MECH_API_KEY: string;
  BASE_URL: string;
  CIRCLEINBOX_API_KEY?: string; // optional — email skipped gracefully if not set
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

export const onRequest: PagesFunction<Env> = async (context) => {
  const { AUTH_SECRET, BASE_URL, MECH_APP_ID, MECH_API_KEY, CIRCLEINBOX_API_KEY } = context.env;

  if (!AUTH_SECRET || !BASE_URL || !MECH_APP_ID || !MECH_API_KEY) {
    console.error('[auth] Missing required env vars: AUTH_SECRET, BASE_URL, MECH_APP_ID, MECH_API_KEY');
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
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
