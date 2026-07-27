import type { Pool } from 'pg';

export interface OperationalJourney {
  available: boolean;
  referrals: number;
  ctwa: number;
  qualified: number;
  quotes: number;
  order_intents: number;
}

interface OperationalJourneyRow {
  referrals: unknown;
  ctwa: unknown;
  qualified: unknown;
  quotes: unknown;
  order_intents: unknown;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadOperationalJourney(
  environment: 'prod' | 'test',
  since: string,
  until: string,
  dbPool: Pool,
): Promise<OperationalJourney> {
  try {
    const result = await dbPool.query<OperationalJourneyRow>(
      `WITH tracked AS (
         SELECT conversation_id, min(sent_at) AS attributed_at
         FROM core.messages
         WHERE environment = $1
           AND sender_type = 'contact'
           AND is_private = false
           AND sent_at >= $2::date
           AND sent_at < ($3::date + 1)
           AND COALESCE(content_attributes #>> '{referral,ctwa_clid}', '') <> ''
         GROUP BY conversation_id
       ),
       referrals AS (
         SELECT DISTINCT conversation_id
         FROM core.messages
         WHERE environment = $1
           AND sender_type = 'contact'
           AND is_private = false
           AND sent_at >= $2::date
           AND sent_at < ($3::date + 1)
           AND content_attributes ? 'referral'
       )
       SELECT
         (SELECT count(*) FROM referrals)::int AS referrals,
         (SELECT count(*) FROM tracked)::int AS ctwa,
         (SELECT count(DISTINCT cc.conversation_id)
            FROM analytics.conversation_classifications cc
            JOIN tracked t ON t.conversation_id = cc.conversation_id
           WHERE cc.environment = $1
             AND cc.dimension = 'stage_reached'
             AND cc.value IN ('quote_sent', 'purchase_intent')
             AND cc.created_at >= t.attributed_at)::int AS qualified,
         (SELECT count(DISTINCT cf.conversation_id)
            FROM analytics.conversation_facts cf
            JOIN tracked t ON t.conversation_id = cf.conversation_id
           WHERE cf.environment = $1
             AND cf.fact_key = 'price_quoted'
             AND cf.superseded_by IS NULL
             AND COALESCE(cf.observed_at, cf.created_at) >= t.attributed_at)::int AS quotes,
         (SELECT count(DISTINCT cf.conversation_id)
            FROM analytics.conversation_facts cf
            JOIN tracked t ON t.conversation_id = cf.conversation_id
           WHERE cf.environment = $1
             AND cf.fact_key = 'pedido_criado'
             AND cf.superseded_by IS NULL
             AND COALESCE(cf.observed_at, cf.created_at) >= t.attributed_at)::int AS order_intents`,
      [environment, since, until],
    );
    const row = result.rows[0];
    return {
      available: true,
      referrals: numberValue(row?.referrals),
      ctwa: numberValue(row?.ctwa),
      qualified: numberValue(row?.qualified),
      quotes: numberValue(row?.quotes),
      order_intents: numberValue(row?.order_intents),
    };
  } catch {
    return {
      available: false,
      referrals: 0,
      ctwa: 0,
      qualified: 0,
      quotes: 0,
      order_intents: 0,
    };
  }
}
