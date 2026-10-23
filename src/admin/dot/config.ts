import { env } from '../../shared/config/env.js';

export const DOT_SCOPE = 'farejador.read';
export const DOT_MCP_PATH = '/admin/dot/mcp';
export const DOT_ACCESS_SECONDS = 15 * 60;
export interface DotConfig { origin: string; resource: string; clientId: string; redirects: string[] }

export function dotConfig(): DotConfig | null {
  if (!env.DOT_MCP_ENABLED) return null;
  const origin = new URL(env.DOT_MCP_PUBLIC_ORIGIN ?? 'about:blank');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
    || origin.search || origin.hash) throw new Error('DOT_MCP_PUBLIC_ORIGIN must be an HTTPS origin');
  const redirects = env.DOT_MCP_REDIRECT_URIS.split(',').map(value => value.trim()).filter(Boolean);
  if (!redirects.length || redirects.some(value => {
    try { const url = new URL(value); return url.protocol !== 'https:' || !!url.username || !!url.password || !!url.hash; }
    catch { return true; }
  })) throw new Error('DOT_MCP_REDIRECT_URIS must contain exact HTTPS callback URLs');
  return { origin: origin.origin, resource: origin.origin + DOT_MCP_PATH, clientId: env.DOT_MCP_CLIENT_ID, redirects };
}
