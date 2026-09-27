import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { containsCheckoutPhone, normalizeCheckoutPhone } from '../shared/phone.js';

export async function resolveOrderPhone(
  client: PoolClient, environment: Environment, conversationId: string,
  contactPhone: string | null, supplied: unknown,
): Promise<string | null> {
  const known = normalizeCheckoutPhone(contactPhone);
  // Um número inválido explicitamente informado precisa de correção, não de fallback silencioso.
  if (supplied == null || supplied === '') return known;
  const candidate = typeof supplied === 'string' ? normalizeCheckoutPhone(supplied) : null;
  if (!candidate) return null;
  if (candidate === known) return known;
  const messages = await client.query<{ content: string }>(
    `SELECT content FROM core.messages
      WHERE environment=$1 AND conversation_id=$2 AND sender_type='contact'
        AND NOT is_private AND deleted_at IS NULL AND NULLIF(trim(content),'') IS NOT NULL
      ORDER BY sent_at DESC,id DESC LIMIT 50`,
    [environment, conversationId],
  );
  return messages.rows.some(row => containsCheckoutPhone(row.content, candidate)) ? candidate : null;
}
