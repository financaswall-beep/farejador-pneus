import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface ShortagePeriod { from: string; to: string }
export interface ShortageFilter extends ShortagePeriod { store?: string; measure?: string; offset?: number }
const base = `WITH searches AS (
  SELECT * FROM ops.bot_stock_searches
  WHERE environment=$1 AND occurred_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND occurred_at < (($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
), missing AS (
  SELECT s.*, st->>'id' AS store_id, st->>'name' AS store_name
  FROM searches s CROSS JOIN LATERAL jsonb_array_elements(s.stores) st
  WHERE st->>'available'='false'
)`;
function params(period: ShortagePeriod, environment: string) { return [environment, period.from, period.to]; }

export async function getBotShortages(period: ShortagePeriod, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  const result = await db.query(`${base}, counts AS (
    SELECT store_id,store_name,measure,count(*)::int AS shortages FROM missing GROUP BY 1,2,3
  ) SELECT
    (SELECT count(DISTINCT search_key)::int FROM missing) AS consultations,
    (SELECT count(*)::int FROM missing) AS shortages,
    (SELECT count(DISTINCT store_id)::int FROM missing) AS store_count,
    (SELECT count(DISTINCT measure)::int FROM missing) AS measure_count,
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
    SELECT DISTINCT id FROM missing WHERE ($4='' OR store_id=$4) AND measure=$5
  ) SELECT s.id,s.occurred_at,s.measure,s.municipality,s.filters,s.stores,
      c.chatwoot_conversation_id::text AS chatwoot_id,
      count(*) OVER()::int AS total
    FROM searches s JOIN selected f USING(id)
    JOIN core.conversations c ON c.id=s.conversation_id AND c.environment=s.environment
    ORDER BY s.occurred_at DESC,s.id LIMIT 20 OFFSET $6`, values);
  const stock = await db.query(`WITH quantities AS (
      SELECT 'matriz'::text AS store_id, sum(quantity_on_hand)::int AS quantity
      FROM commerce.wholesale_stock WHERE environment=$1 AND upper(btrim(measure))=$2
      HAVING count(*)>0
      UNION ALL
      SELECT sl.unit_id::text,sum(sl.quantity_on_hand)::int
      FROM commerce.partner_stock_levels sl
      WHERE sl.environment=$1 AND upper(btrim(sl.tire_size))=$2 AND sl.deleted_at IS NULL
        AND sl.is_tracked=true AND sl.quantity_on_hand IS NOT NULL AND sl.tire_condition IS NOT NULL
      GROUP BY sl.unit_id
    ) SELECT * FROM quantities`, [environment, filter.measure]);
  return { rows: result.rows, total: result.rows[0]?.total ?? 0, stock: stock.rows };
}

export async function exportBotShortages(filter: ShortageFilter, environment = env.FAREJADOR_ENV, db: Pool = pool) {
  return (await db.query(`${base} SELECT id,occurred_at,measure,municipality,store_name,filters,
    CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(stores) st WHERE st->>'available'='true')
      THEN 'Havia disponibilidade em outra loja consultada' ELSE 'Sem disponibilidade nas lojas consultadas' END AS result
    FROM missing WHERE ($4='' OR store_id=$4) AND ($5='' OR measure ILIKE '%'||$5||'%')
    ORDER BY occurred_at DESC,id,store_id LIMIT 10001`,
  [...params(filter, environment), filter.store ?? '', filter.measure ?? ''])).rows;
}
