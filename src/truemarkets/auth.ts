import { createPrivateKey, createPublicKey, sign, type KeyObject, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export function officialBase(value: string, allowed: string[]): string {
  const url = new URL(value);
  if (!allowed.includes(url.origin + url.pathname.replace(/\/$/, '')) || url.username || url.password || url.search || url.hash)
    throw new Error('Unapproved True Markets endpoint');
  return value.replace(/\/$/, '');
}
export class ApiError extends Error {
  constructor(public status: number, public code?: string) {
    super(`True Markets HTTP ${status}${code ? ` (${code})` : ''}`);
  }
}
export async function readResponse(response: Response): Promise<any> {
  let body: any;
  try { body = await response.json(); } catch { throw new Error(`Invalid True Markets JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    const code = body?.error?.code ?? body?.code;
    throw new ApiError(response.status, typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : undefined);
  }
  return body;
}
export class ApiKeySigner {
  private key: KeyObject;
  readonly publicKeyHex: string;
  constructor(readonly keyId: string, jwk: JsonWebKey) {
    if (!keyId || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('Expected an ES256 private JWK');
    this.key = createPrivateKey({ key: jwk, format: 'jwk' });
    const pub = createPublicKey(this.key).export({ format: 'jwk' });
    const x = Buffer.from(pub.x!, 'base64url'), y = Buffer.from(pub.y!, 'base64url');
    this.publicKeyHex = Buffer.concat([Buffer.from([y[31] % 2 ? 3 : 2]), x]).toString('hex');
  }
  static fromFile(path: string) {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (file.algorithm !== 'ES256') throw new Error();
      return new ApiKeySigner(file.key_id, file.private_key);
    } catch { throw new Error('Cannot load ES256 key file'); }
  }
  challenge(timestamp: number): string {
    return sign('sha256', Buffer.from(`${this.keyId}.${timestamp}`), { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  }
  stamp(payload: string): string {
    return Buffer.from(JSON.stringify({ publicKey: this.publicKeyHex,
      signature: sign('sha256', Buffer.from(payload, 'utf8'), { key: this.key, dsaEncoding: 'der' }).toString('hex'),
      scheme: 'SIGNATURE_SCHEME_TK_API_P256' })).toString('base64url');
  }
}
export interface AuthOptions {
  baseUrl: string; expectedUserId: string; expectedClientId?: string;
  signer: ApiKeySigner; fetch?: Fetcher; now?: () => number; timeoutMs?: number;
}
export class TokenManager {
  private access?: string;
  private refresh?: string;
  private expiresAt = 0;
  private pending?: Promise<string>;
  private claims: any;
  private base: string;
  constructor(private options: AuthOptions) {
    this.base = officialBase(options.baseUrl, ['https://api.truemarkets.co/v1/auth', 'https://api.uat.truemarkets.co/v1/auth']);
    if (!options.expectedUserId) throw new Error('Expected account identity is required');
  }
  get environment() { return this.base.includes('.uat.') ? 'uat' : 'production'; }
  get identity(): { userId: string; clientId?: string } | undefined {
    return this.claims ? { userId: this.claims.uid ?? this.claims.sub, clientId: this.claims.tm?.client_id ?? this.claims.client_id } : undefined;
  }
  invalidate() { this.access = undefined; this.expiresAt = 0; }
  async token(): Promise<string> {
    const now = this.options.now ?? Date.now;
    if (this.access && this.expiresAt > now() + 60_000) return this.access;
    if (this.pending) return this.pending;
    this.pending = this.obtain().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async obtain(): Promise<string> {
    const now = this.options.now ?? Date.now;
    const request = async (path: string, body: any) => readResponse(await (this.options.fetch ?? fetch)(this.base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
    }));
    let result: any;
    if (this.refresh) {
      try { result = await request('/token/refresh', { refresh_token: this.refresh }); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; this.refresh = undefined; }
    }
    if (!result) {
      const timestamp = Math.floor(now() / 1000);
      result = await request('/api-key/token', { key_id: this.options.signer.keyId, timestamp, signature: this.options.signer.challenge(timestamp) });
    }
    if (typeof result.access_token !== 'string') throw new Error('Access token missing');
    let claims: any;
    try { claims = JSON.parse(Buffer.from(result.access_token.split('.')[1], 'base64url').toString()); }
    catch { throw new Error('Malformed access token'); }
    // Identity guard on a token obtained directly from the allowlisted HTTPS server;
    // decoding is not a replacement for independent JWT signature verification.
    if ((claims.uid ?? claims.sub) !== this.options.expectedUserId ||
      (this.options.expectedClientId && (claims.tm?.client_id ?? claims.client_id) !== this.options.expectedClientId) ||
      (claims.tm?.client_id && claims.client_id && claims.tm.client_id !== claims.client_id)) {
      this.access = this.refresh = undefined; this.claims = undefined;
      throw new Error('API-key account/client does not match configured identity');
    }
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now() + 60_000) throw new Error('Token expiration invalid');
    this.access = result.access_token; this.refresh = result.refresh_token; this.claims = claims; this.expiresAt = claims.exp * 1000;
    return this.access!;
  }
}
