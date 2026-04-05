import { getSessionFromCookie, createMechKysely } from 'clearauth/edge';

interface Env {
  MECH_APP_ID: string;
  MECH_API_KEY: string;
  HETZNER_API_URL: string;
  ADMIN_API_TOKEN: string;
}

// Allowlist of permitted upstream path prefixes.
// Prevents authenticated users from using the proxy to reach unintended upstream paths.
const ALLOWED_PREFIXES = [
  '/api/v1/health',
  '/api/v1/stats',
  '/api/v1/analytics/',
  '/api/v1/fills',
  '/api/v1/orders',
  '/api/v1/sessions',
  '/api/v1/logs/',
  '/api/v1/orphaned-orders',
  '/api/status',
];

function isAllowedPath(path: string): boolean {
  return ALLOWED_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix));
}

// Safe response headers to forward from upstream.
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-total-count', 'x-page', 'x-per-page'];

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

  // 2. Build and validate upstream path
  const url = new URL(context.request.url);
  const upstreamPath = url.pathname.replace(/^\/api\/proxy/, '');

  if (!isAllowedPath(upstreamPath)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const upstreamUrl = `${context.env.HETZNER_API_URL}${upstreamPath}${url.search}`;

  // 3. Forward to upstream with admin token
  const hasBody = !['GET', 'HEAD'].includes(context.request.method);
  const upstream = await fetch(upstreamUrl, {
    method: context.request.method,
    headers: {
      'Authorization': `Bearer ${context.env.ADMIN_API_TOKEN}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? context.request.body : undefined,
  });

  // 4. Forward safe response headers + add cache control
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};
