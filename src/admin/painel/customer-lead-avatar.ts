import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

interface AvatarConfig { baseUrl: string; apiToken: string }
interface ContactRef { contact_id: number; account_id: number }
const avatars = new Map<string, { expires: number; value: Promise<string | null> }>();

/** URL fornecida pelo Chatwoot; a imagem é carregada pelo navegador, sem expor o token. */
export function safeContactAvatar(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export async function getCustomerLeadAvatar(
  conversationId: string,
  environment: 'prod' | 'test',
  dbPool: Pool = defaultPool,
  config: AvatarConfig | null = env.CHATWOOT_API_BASE_URL && env.CHATWOOT_API_TOKEN
    ? { baseUrl: env.CHATWOOT_API_BASE_URL, apiToken: env.CHATWOOT_API_TOKEN } : null,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const result = await dbPool.query<ContactRef>(
    `SELECT c.chatwoot_contact_id AS contact_id, cv.chatwoot_account_id AS account_id
       FROM core.conversations cv JOIN core.contacts c ON c.id=cv.contact_id AND c.environment=cv.environment
      WHERE cv.id=$1 AND cv.environment=$2 AND cv.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [conversationId, environment],
  );
  const contact = result.rows[0];
  if (!contact) throw new Error('lead_conversation_not_found');
  if (!config || !Number.isSafeInteger(Number(contact.account_id)) || Number(contact.account_id) <= 0
    || !Number.isSafeInteger(Number(contact.contact_id)) || Number(contact.contact_id) <= 0) return null;
  const root = config.baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  const key = `${environment}:${root}:${contact.account_id}:${contact.contact_id}`;
  const cached = avatars.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    try {
      const response = await fetchFn(`${root}/api/v1/accounts/${contact.account_id}/contacts/${contact.contact_id}`, {
        headers: { api_access_token: config.apiToken },
        signal: AbortSignal.timeout(4000), redirect: 'error',
      });
      if (!response.ok) return null;
      const body = await response.json() as { payload?: { thumbnail?: unknown; avatar_url?: unknown } };
      return safeContactAvatar(body.payload?.thumbnail, root)
        ?? safeContactAvatar(body.payload?.avatar_url, root);
    } catch { return null; }
  })();
  // Cache curto, limitado e sem nome, telefone ou corpo da resposta do contato.
  if (avatars.size >= 500) avatars.delete(avatars.keys().next().value!);
  avatars.set(key, { expires: Date.now() + 60_000, value });
  return value;
}
