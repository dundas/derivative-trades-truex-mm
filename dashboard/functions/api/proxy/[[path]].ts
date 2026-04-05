import { getSessionFromCookie, createMechKysely } from 'clearauth/edge';

interface Env {
  MECH_APP_ID: string;
  MECH_API_KEY: string;
  HETZNER_API_URL: string;
  ADMIN_API_TOKEN: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  // 1. Validate session
  const db = createMechKysely({ appId: context.env.MECH_APP_ID, apiKey: context.env.MECH_API_KEY });
  const session = await getSessionFromCookie(context.request, db);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Build upstream URL — strip /api/proxy prefix, forward the rest
  const url = new URL(context.request.url);
  const upstreamPath = url.pathname.replace(/^\/api\/proxy/, '');
  const upstreamUrl = `${context.env.HETZNER_API_URL}${upstreamPath}${url.search}`;

  // 3. Forward with admin token
  const upstream = await fetch(upstreamUrl, {
    method: context.request.method,
    headers: {
      'Authorization': `Bearer ${context.env.ADMIN_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: ['GET', 'HEAD'].includes(context.request.method) ? undefined : context.request.body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
};
