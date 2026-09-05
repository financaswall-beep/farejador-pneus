import type { Pool } from 'pg';

/** Recupera apenas a referência que já veio no webhook, com conversa E contato iguais.
 * Nunca adivinha a conta pela configuração global nem mistura prod/test. */
export async function readLeadChatwootReference(db: Pool, environment: string,
  conversationId: number, contactId: number, accountId: number,
): Promise<{ account_id: number; thumbnail: unknown } | null> {
  const result = await db.query<{ account_id: number; thumbnail: unknown }>(
    `SELECT account_id,
       COALESCE(NULLIF(payload#>>'{conversation,meta,sender,thumbnail}',''),
         NULLIF(payload#>>'{meta,sender,thumbnail}','')) AS thumbnail
       FROM raw.raw_events
      WHERE environment=$1 AND account_id>0 AND ($4::integer<=0 OR account_id=$4)
        AND ((payload @> $2::jsonb) OR
          (event_type LIKE 'conversation_%' AND payload @> $3::jsonb))
      ORDER BY received_at DESC LIMIT 1`,
    [environment,
      JSON.stringify({ conversation:{ id:conversationId,meta:{ sender:{ id:contactId } } } }),
      JSON.stringify({ id:conversationId,meta:{ sender:{ id:contactId } } }), accountId],
  );
  return result.rows[0] ?? null;
}
