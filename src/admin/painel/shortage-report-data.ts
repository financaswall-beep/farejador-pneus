import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { ShortageReportLimitError,type ShortageReportFilter } from './shortage-report-filter.js';
import type { ShortageSnapshot,ShortageTrace,ShortageProduct,ShortageStock } from './shortage-report-types.js';
const dateRange=`occurred_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
  AND occurred_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
export async function readShortageSnapshot(f:ShortageReportFilter,environment=env.FAREJADOR_ENV,db:Pool=pool):Promise<ShortageSnapshot>{
  const c=await db.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='15s'");
    const params=[environment,f.from,f.to];
    const meta=(await c.query<{as_of:Date;tracking_since:Date|null;legacy_records:number}>(`SELECT now() AS as_of,
      (SELECT min(occurred_at) FROM ops.bot_stock_searches WHERE environment=$1) AS tracking_since,
      (SELECT count(*)::int FROM analytics.conversation_facts f WHERE f.environment=$1 AND f.fact_key='faltou_estoque'
        AND f.superseded_by IS NULL
        AND COALESCE(f.observed_at,f.created_at)>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND COALESCE(f.observed_at,f.created_at)<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND NOT EXISTS(SELECT 1 FROM ops.bot_stock_searches s WHERE s.environment=f.environment
          AND s.conversation_id=f.conversation_id AND s.trigger_message_id=f.message_id
          AND s.measure=upper(btrim(f.fact_value->>'medida')))) AS legacy_records`,params)).rows[0]!;
    const traces=(await c.query<Omit<ShortageTrace,'occurred_at'>&{occurred_at:Date}>(`SELECT id,conversation_id,search_key,occurred_at,measure,municipality,filters,stores
      FROM ops.bot_stock_searches WHERE environment=$1 AND ${dateRange}
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(stores) st WHERE st->>'available'='false')
      ORDER BY occurred_at DESC,id LIMIT 20001`,params)).rows;
    if(traces.length>20000)throw new ShortageReportLimitError();
    const ids=[...new Set(traces.flatMap(t=>t.stores.filter(s=>s.id!=='matriz').map(s=>s.id)))];
    // Current channel prices only. The immutable search trace never recorded a historical price.
    const products=traces.length?(await c.query<ShortageProduct>(`SELECT p.id,ts.tire_size AS measure,p.brand,p.tire_condition AS condition,ts.position,
      mp.price_amount::float8 AS matrix_price,mp.currency AS matrix_currency,
      pp.price_amount::float8 AS partner_price,pp.currency AS partner_currency
      FROM commerce.products p JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
      LEFT JOIN commerce.matriz_current_prices mp ON mp.product_id=p.id AND mp.environment=p.environment
      LEFT JOIN LATERAL(SELECT price_amount,currency FROM commerce.product_prices
        WHERE environment=p.environment AND product_id=p.id AND price_type='regular'
        AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) ORDER BY valid_from DESC,id DESC LIMIT 1) pp ON true
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.product_type='tire' ORDER BY p.id LIMIT 20001`,[environment])).rows:[];
    const stock=traces.length?(await c.query<ShortageStock>(`SELECT 'matriz'::text AS store_id,measure,
      GREATEST(quantity_on_hand-COALESCE(quantity_reserved,0),0)::int AS available,false AS unknown
      FROM commerce.wholesale_stock WHERE environment=$1
      UNION ALL SELECT unit_id::text,tire_size,GREATEST(COALESCE(quantity_on_hand,0)-COALESCE(quantity_reserved,0),0)::int,
        (NOT is_tracked OR quantity_on_hand IS NULL OR tire_condition IS NULL) AS unknown
      FROM commerce.partner_stock_levels WHERE environment=$1 AND unit_id::text=ANY($2::text[]) AND deleted_at IS NULL
      LIMIT 50001`,[environment,ids])).rows:[];
    const cities=ids.length?(await c.query<{id:string;city:string|null}>(`SELECT unit_id::text AS id,address_city AS city FROM network.partner_units
      WHERE environment=$1 AND unit_id::text=ANY($2::text[])`,[environment,ids])).rows:[];
    if(products.length>20000||stock.length>50000)throw new ShortageReportLimitError();
    await c.query('COMMIT');return{as_of:meta.as_of.toISOString(),tracking_since:meta.tracking_since?.toISOString()||null,
      legacy_records:meta.legacy_records,products,stock,cities,traces:traces.map(t=>({...t,occurred_at:t.occurred_at.toISOString()}))};
  }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}
