import { GOOGLE_TOKEN_URL, googleServiceAccountTokenBody } from './google-service-account.js';

/** Cliente REST exclusivamente de leitura. Nunca registra respostas brutas ou credenciais. */
export interface GoogleAdsConfig {
  environment: 'prod' | 'test';
  customerId: string;
  loginCustomerId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  serviceAccountJson?: string;
  apiVersion: string;
  scope: 'account' | 'campaigns';
  campaignIds: string[];
}

export class GoogleAdsError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'GoogleAdsError'; }
}

export function validateGoogleAdsConfig(config: GoogleAdsConfig): void {
  if (!/^\d{10}$/.test(config.customerId)
    || (config.loginCustomerId && !/^\d{10}$/.test(config.loginCustomerId))
    || !/^v\d+$/.test(config.apiVersion)
    || !['prod', 'test'].includes(config.environment)
    || (!config.serviceAccountJson && (!config.clientId || !config.clientSecret || !config.refreshToken))
    || !['account', 'campaigns'].includes(config.scope)
    || (config.scope === 'campaigns' && !config.campaignIds.length)
    || config.campaignIds.length > 200
    || config.campaignIds.some(id => !/^\d+$/.test(id))) {
    throw new GoogleAdsError('invalid_config');
  }
}

const authorizationCodes = new Set([
  'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'USER_PERMISSION_DENIED',
  'CUSTOMER_NOT_ENABLED', 'ACTION_NOT_PERMITTED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'GOOGLE_ACCOUNT_COOKIE_INVALID', 'OAUTH_TOKEN_INVALID', 'OAUTH_TOKEN_EXPIRED',
]);

function apiError(body: unknown, status: number): GoogleAdsError {
  // Whitelist de códigos: a mensagem externa pode conter IDs, consultas e dados sensíveis.
  const details = (body as { error?: { details?: Array<{ errors?: Array<{ errorCode?: Record<string, string> }> }> } })?.error?.details;
  if (Array.isArray(details)) for (const detail of details) {
    if (Array.isArray(detail.errors)) for (const error of detail.errors) {
      for (const code of Object.values(error.errorCode ?? {})) {
        if (authorizationCodes.has(code)) return new GoogleAdsError(code);
      }
    }
  }
  return new GoogleAdsError(status === 429 ? 'quota_exceeded' : status === 401 || status === 403 ? 'access_denied' : 'api_unavailable');
}

async function requestJson(fetcher: typeof fetch, url: string, init: RequestInit): Promise<{ response: Response; body: Record<string, unknown> }> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error' });
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GoogleAdsError('invalid_response');
    return { response, body: body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof GoogleAdsError) throw error;
    throw new GoogleAdsError('api_unavailable');
  }
}

export async function googleAdsReader(config: GoogleAdsConfig, fetcher: typeof fetch = fetch) {
  validateGoogleAdsConfig(config);
  const deadline = AbortSignal.timeout(60_000);
  let tokenBody: URLSearchParams;
  if (config.serviceAccountJson) {
    try { tokenBody = googleServiceAccountTokenBody(config.serviceAccountJson); }
    catch { throw new GoogleAdsError('invalid_service_account'); }
  } else {
    tokenBody = new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId!,
      client_secret: config.clientSecret!, refresh_token: config.refreshToken! });
  }
  const { response, body } = await requestJson(fetcher, GOOGLE_TOKEN_URL, {
    method: 'POST', signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) {
    throw new GoogleAdsError(body.error === 'invalid_grant' ? 'authorization_expired' : 'oauth_failed');
  }
  const token: string = body.access_token;
  return async function search<T>(query: string): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await requestJson(fetcher,
        `https://googleads.googleapis.com/${config.apiVersion}/customers/${config.customerId}/googleAds:search`, {
          method: 'POST', signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            ...(config.loginCustomerId ? { 'login-customer-id': config.loginCustomerId } : {}) },
          body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
        });
      if (!result.response.ok || result.body.error) throw apiError(result.body, result.response.status);
      // Protobuf JSON omite results quando não há linhas.
      const batch = result.body.results ?? [];
      if (!Array.isArray(batch) || batch.length > 10_000) throw new GoogleAdsError('invalid_response');
      rows.push(...batch);
      const next = result.body.nextPageToken;
      if (next == null || next === '') return rows;
      if (typeof next !== 'string' || seen.has(next)) throw new GoogleAdsError('invalid_pagination');
      seen.add(next); pageToken = next;
    }
    throw new GoogleAdsError('pagination_limit');
  };
}
