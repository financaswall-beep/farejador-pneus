import type { Pool } from 'pg';

export interface OperationalJourney {
  available: boolean;
  referrals: number;
  tracked: number;
  ctwa: number;
  messenger: number;
  instagram: number;
  qualified: number;
  quotes: number;
  order_intents: number;
}

interface OperationalJourneyRow {
  referrals: unknown;
  tracked: unknown;
  ctwa: unknown;
  messenger: unknown;
  instagram: unknown;
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
         SELECT conversation_id,min(captured_at) AS attributed_at,
                bool_or(channel='whatsapp') AS has_whatsapp,
                bool_or(channel='messenger') AS has_messenger,
                bool_or(channel='instagram') AS has_instagram
         FROM marketing.ad_referrals
         WHERE environment = $1
           AND captured_at >= $2::date
           AND captured_at < ($3::date + 1)
         GROUP BY conversation_id
       ),
       referrals AS (
         SELECT DISTINCT conversation_id
         FROM marketing.ad_referrals
         WHERE environment = $1
           AND captured_at >= $2::date
           AND captured_at < ($3::date + 1)
       )
       SELECT
         (SELECT count(*) FROM referrals)::int AS referrals,
         (SELECT count(*) FROM tracked)::int AS tracked,
         (SELECT count(*) FROM tracked WHERE has_whatsapp)::int AS ctwa,
         (SELECT count(*) FROM tracked WHERE has_messenger)::int AS messenger,
         (SELECT count(*) FROM tracked WHERE has_instagram)::int AS instagram,
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
      tracked: numberValue(row?.tracked ?? row?.referrals),
      ctwa: numberValue(row?.ctwa),
      messenger: numberValue(row?.messenger),
      instagram: numberValue(row?.instagram),
      qualified: numberValue(row?.qualified),
      quotes: numberValue(row?.quotes),
      order_intents: numberValue(row?.order_intents),
    };
  } catch {
    return {
      available: false,
      referrals: 0,
      tracked: 0,
      ctwa: 0,
      messenger: 0,
      instagram: 0,
      qualified: 0,
      quotes: 0,
      order_intents: 0,
    };
  }
}
