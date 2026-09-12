import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface ShortagePeriod { from: string; to: string }
export interface ShortageFilter extends ShortagePeriod { store?: string; measure?: string; offset?: number }
const base = `WITH searches AS (
  SELECT *,commerce.wholesale_measure_key(measure) AS measure_key FROM ops.bot_stock_searches
  WHERE environment=$1 AND occurred_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND occurred_at < (($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
), missing AS (
  SELECT s.*, st->>'id' AS store_id, st->>'name' AS store_name
  FROM searches s CROSS JOIN LATERAL jsonb_array_elements(s.stores) st
  WHERE st->>'available'='false'
), missing_once AS (
  -- Cada medida conta uma vez por conversa e loja no período. A trilha permanece intacta.
  SELECT DISTINCT ON (conversation_id,measure_key,store_id) *,
    count(*) OVER (PARTITION BY conversation_id,measure_key,store_id)::int AS searches
  FROM missing ORDER BY conversation_id,measure_key,store_id,occurred_at DESC,id
), labels AS (
  SELECT measure_key,min(measure) AS measure FROM missing GROUP BY measure_key
)`;
function params(period: ShortagePeriod, environment: string) { return [environment, period.from, period.to]; }

export async function getBotShortages(period: ShortagePeriod, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  const result = await db.query(`${base}, counts AS (
    SELECT store_id,max(store_name) AS store_name,min(labels.measure) AS measure,count(*)::int AS shortages
    FROM missing_once JOIN labels USING(measure_key) GROUP BY store_id,measure_key
  ) SELECT
    (SELECT count(DISTINCT conversation_id)::int FROM missing_once) AS consultations,
    (SELECT count(*)::int FROM missing_once) AS shortages,
    (SELECT count(DISTINCT store_id)::int FROM missing) AS store_count,
    (SELECT count(DISTINCT measure_key)::int FROM missing) AS measure_count,
    COALESCE((SELECT jsonb_agg(counts ORDER BY shortages DESC,measure,store_id) FROM counts),'[]') AS counts,
    (SELECT min(occurred_at) FROM ops.bot_stock_searches WHERE environment=$1) AS tracking_since,
    (SELECT count(*)::int FROM analytics.conversation_facts f
     WHERE f.environment=$1 AND f.fact_key='faltou_estoque' AND f.superseded_by IS NULL
       AND COALESCE(f.observed_at,f.created_at) >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND COALESCE(f.observed_at,f.created_at) < (($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND NOT EXISTS (SELECT 1 FROM ops.bot_stock_searches s
         WHERE s.environment=f.environment AND s.trigger_message_id=f.message_id
           AND s.conversation_id=f.conversation_id AND s.measure=upper(btrim(f.fact_value->>'medida')))
    ) AS legacy_records`, params(period, environment));
  return { ...result.rows[0], from: period.from, to: period.to };
}

export async function getBotShortageConsultations(filter: ShortageFilter, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  const values = [...params(filter, environment), filter.store ?? '', filter.measure ?? '', filter.offset ?? 0];
  const result = await db.query(`${base}, selected AS (
    SELECT DISTINCT id FROM missing WHERE ($4='' OR store_id=$4) AND measure_key=commerce.wholesale_measure_key($5)
  ) SELECT s.id,s.occurred_at,s.measure,s.municipality,s.filters,s.stores,
      c.chatwoot_conversation_id::text AS chatwoot_id,
      count(*) OVER(PARTITION BY s.conversation_id,s.measure_key)::int AS searches,
      count(*) OVER()::int AS total
    FROM searches s JOIN selected f USING(id)
    JOIN core.conversations c ON c.id=s.conversation_id AND c.environment=s.environment
    ORDER BY s.occurred_at DESC,s.id LIMIT 20 OFFSET $6`, values);
  const stock = await db.query(`WITH quantities AS (
      SELECT 'matriz'::text AS store_id, sum(quantity_on_hand)::int AS quantity
      FROM commerce.wholesale_stock WHERE environment=$1 AND commerce.wholesale_measure_key(measure)=commerce.wholesale_measure_key($2)
      HAVING count(*)>0
      UNION ALL
      SELECT sl.unit_id::text,sum(sl.quantity_on_hand)::int
      FROM commerce.partner_stock_levels sl
      WHERE sl.environment=$1 AND commerce.wholesale_measure_key(sl.tire_size)=commerce.wholesale_measure_key($2) AND sl.deleted_at IS NULL
        AND sl.is_tracked=true AND sl.quantity_on_hand IS NOT NULL AND sl.tire_condition IS NOT NULL
      GROUP BY sl.unit_id
    ) SELECT * FROM quantities`, [environment, filter.measure]);
  return { rows: result.rows, total: result.rows[0]?.total ?? 0, stock: stock.rows };
}

export async function exportBotShortages(filter: ShortageFilter, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  return (await db.query(`${base} SELECT id,occurred_at,measure,municipality,store_name,filters,searches,
    CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(stores) st WHERE st->>'available'='true')
      THEN 'Havia disponibilidade em outra loja consultada' ELSE 'Sem disponibilidade nas lojas consultadas' END AS result
    FROM missing_once WHERE ($4='' OR store_id=$4)
      AND ($5='' OR commerce.wholesale_measure_key(measure) LIKE '%'||commerce.wholesale_measure_key($5)||'%')
    ORDER BY occurred_at DESC,id,store_id LIMIT 10001`,
  [...params(filter, environment), filter.store ?? '', filter.measure ?? ''])).rows;
}
