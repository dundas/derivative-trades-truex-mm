import { createClearAuth, handleClearAuthEdgeRequest } from 'clearauth/edge';

interface Env {
  AUTH_SECRET: string;
  MECH_APP_ID: string;
  MECH_API_KEY: string;
  BASE_URL: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { AUTH_SECRET, BASE_URL, MECH_APP_ID, MECH_API_KEY } = context.env;

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
  });

  return handleClearAuthEdgeRequest(context.request, config);
};
