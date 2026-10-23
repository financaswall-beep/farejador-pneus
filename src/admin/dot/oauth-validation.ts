import { z } from 'zod';
import { DOT_SCOPE, type DotConfig } from './config.js';

const authorization = z.object({
  response_type: z.literal('code'), client_id: z.string().max(120),
  redirect_uri: z.string().url().max(2048), resource: z.string().url().max(2048),
  scope: z.literal(DOT_SCOPE), state: z.string().min(1).max(512),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
}).strict();
export type DotAuthorization = z.infer<typeof authorization>;
export function parseAuthorization(config: DotConfig, input: unknown): DotAuthorization | null {
  const parsed = authorization.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data;
  return value.client_id === config.clientId && value.resource === config.resource
    && config.redirects.includes(value.redirect_uri) ? value : null;
}
export function authorizationRedirect(config: DotConfig, params: DotAuthorization, result: {code:string}|{error:string}) {
  if (!config.redirects.includes(params.redirect_uri)) throw new Error('invalid_redirect_uri');
  const url = new URL(params.redirect_uri);
  for (const [key,value] of Object.entries({...result,state:params.state,iss:config.origin})) url.searchParams.set(key,value);
  return url.href;
}
export const dotTokenBody = z.object({
  grant_type: z.enum(['authorization_code','refresh_token']), client_id: z.string().max(120),
  resource: z.string().url().max(2048), code: z.string().max(100).optional(),
  redirect_uri: z.string().url().max(2048).optional(),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(),
  refresh_token: z.string().max(100).optional(), scope: z.literal(DOT_SCOPE).optional(),
}).strict();
