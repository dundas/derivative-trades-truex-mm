import { createClearAuth, handleClearAuthEdgeRequest } from 'clearauth/edge';

interface Env {
  AUTH_SECRET: string;
  MECH_APP_ID: string;
  MECH_API_KEY: string;
  BASE_URL: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const config = createClearAuth({
    secret: context.env.AUTH_SECRET,
    baseUrl: context.env.BASE_URL || 'https://truex-dashboard.pages.dev',
    database: {
      appId: context.env.MECH_APP_ID,
      apiKey: context.env.MECH_API_KEY,
    },
    isProduction: true,
  });
  return handleClearAuthEdgeRequest(context.request, config);
};
