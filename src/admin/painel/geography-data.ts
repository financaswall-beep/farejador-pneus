import type { Pool } from 'pg';
import type { GeoBinding, GeoInsight, GeoReferral, GeoSale, GeoSnapshot, GeoStock } from '../../marketing/geography-types.js';
import { readDeliverySettings } from '../../atendente-v2/matriz-delivery-settings.js';

const ADS=`SELECT DISTINCT ON(entity_id) entity_id,campaign_id FROM marketing.meta_insights_daily
  WHERE environment=$1 AND ad_account_id=$2 AND entity_level='ad' ORDER BY entity_id,metric_date DESC,collected_at DESC`;
const VALID=`o.partner_order_id IS NULL AND o.status IN ('confirmed','paid','delivered')
  AND NOT(o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')`;
export const geoReferralsSql=`WITH ads AS (${ADS})
 SELECT r.id,r.conversation_id,ads.campaign_id,r.source_id AS ad_id,l.municipio AS municipality,
  r.captured_at::text,to_char(r.captured_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day,
  r.captured_at<=$5::timestamptz-interval '7 days' AS mature
 FROM marketing.ad_referrals r JOIN ads ON ads.entity_id=r.source_id
 JOIN marketing.campaign_scopes sc ON sc.environment=$1 AND sc.ad_account_id=$2 AND sc.campaign_id=ads.campaign_id AND sc.scope='matrix'
 JOIN core.conversations c ON c.environment=$1 AND c.id=r.conversation_id AND c.deleted_at IS NULL
 LEFT JOIN analytics.v_bot_demand_location l ON l.environment=$1 AND l.conversation_id=r.conversation_id
 WHERE r.environment=$1 AND r.captured_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
 AND r.captured_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
 ORDER BY r.captured_at,r.id LIMIT 50001`;
export const geoSalesSql=`WITH ads AS (${ADS})
 SELECT o.id,a.referral_id,a.conversation_id,ads.campaign_id,r.source_id AS ad_id,l.municipio AS municipality,
 to_char(a.realized_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day,
 r.captured_at::text,a.realized_at::text,o.total_amount::float8 AS revenue,
 CASE WHEN costs.n>0 AND costs.missing=0 THEN (o.total_amount-costs.total)::float8 ELSE NULL END AS margin
 FROM marketing.order_attributions a JOIN marketing.ad_referrals r ON r.environment=a.environment AND r.id=a.referral_id
 JOIN ads ON ads.entity_id=r.source_id
 JOIN marketing.campaign_scopes sc ON sc.environment=$1 AND sc.ad_account_id=$2 AND sc.campaign_id=ads.campaign_id AND sc.scope='matrix'
 JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.order_id
 JOIN core.conversations c ON c.environment=$1 AND c.id=a.conversation_id AND c.deleted_at IS NULL
 LEFT JOIN analytics.v_bot_demand_location l ON l.environment=$1 AND l.conversation_id=a.conversation_id
 LEFT JOIN LATERAL(SELECT count(*) n,count(*) FILTER(WHERE oi.matriz_unit_cost IS NULL) missing,
   sum(oi.quantity*oi.matriz_unit_cost) total FROM commerce.order_items oi WHERE oi.environment=$1 AND oi.order_id=o.id) costs ON true
 WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL AND ${VALID}
 AND a.realized_at>=r.captured_at AND a.realized_at<r.captured_at+interval '7 days'
 AND a.realized_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND a.realized_at<=$5::timestamptz
 AND a.realized_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
 ORDER BY a.realized_at,a.id LIMIT 50001`;

export async function loadGeographyData(db:Pool,environment:'prod'|'test',account:string,since:string,until:string,now:Date) {
  const c=await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='20s'");
    const params=[environment,account,since,until,now.toISOString()];
    const catalog=(await c.query<{id:string;name:string;scope:string}>(`SELECT DISTINCT ON(mi.campaign_id)
      mi.campaign_id AS id,mi.campaign_name AS name,COALESCE(sc.scope,'pending') AS scope
      FROM marketing.meta_insights_daily mi LEFT JOIN marketing.campaign_scopes sc
      ON sc.environment=mi.environment AND sc.ad_account_id=mi.ad_account_id AND sc.campaign_id=mi.campaign_id
      WHERE mi.environment=$1 AND mi.ad_account_id=$2 AND mi.metric_date BETWEEN $3::date AND $4::date
      ORDER BY mi.campaign_id,mi.metric_date DESC LIMIT 1001`,params.slice(0,4))).rows;
    const insights=(await c.query<GeoInsight>(`SELECT mi.campaign_id,mi.campaign_name,mi.metric_date::text AS day,
      mi.spend::float8,mi.account_currency AS currency,mi.conversations,mi.collected_at::text
      FROM marketing.meta_insights_daily mi JOIN marketing.campaign_scopes sc
      ON sc.environment=mi.environment AND sc.ad_account_id=mi.ad_account_id AND sc.campaign_id=mi.campaign_id AND sc.scope='matrix'
      WHERE mi.environment=$1 AND mi.ad_account_id=$2 AND mi.entity_level='campaign'
      AND mi.metric_date BETWEEN $3::date AND $4::date ORDER BY mi.metric_date,mi.campaign_id LIMIT 50001`,params.slice(0,4))).rows;
    const refs=(await c.query<GeoReferral>(geoReferralsSql,params)).rows;
    const sales=(await c.query<GeoSale>(geoSalesSql,params)).rows;
    const bindings=(await c.query<GeoBinding>(`SELECT id::text,campaign_id,allocation,municipality,valid_from::text,valid_until::text,coverage,offers,reason
      FROM marketing.geography_bindings WHERE environment=$1 AND ad_account_id=$2 ORDER BY id DESC LIMIT 10001`,params.slice(0,2))).rows;
    const snapshots=(await c.query<GeoSnapshot>(`SELECT campaign_id,observed_at::text,payload
      FROM marketing.geography_meta_snapshots WHERE environment=$1 AND ad_account_id=$2
      AND observed_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo') ORDER BY observed_at DESC LIMIT 20001`,params.slice(0,3))).rows;
    const stock=(await c.query<GeoStock>(`SELECT measure,brand,tire_condition AS condition,
      greatest(0,quantity_on_hand-COALESCE(quantity_reserved,0))::float8 AS available
      FROM commerce.wholesale_stock WHERE environment=$1 LIMIT 20001`,[environment])).rows;
    const offers=(await c.query<{measure:string;brand:string;condition:string}>(`SELECT DISTINCT ts.tire_size AS measure,p.brand,p.tire_condition AS condition
      FROM commerce.tire_specs ts JOIN commerce.products p ON p.environment=ts.environment AND p.id=ts.product_id
      WHERE ts.environment=$1 AND ts.tire_size IS NOT NULL AND p.brand IS NOT NULL AND p.deleted_at IS NULL
      ORDER BY ts.tire_size,p.brand,p.tire_condition LIMIT 10001`,[environment])).rows;
    const ads=(await c.query<{id:string;name:string;campaign_id:string;last_spend_day:string|null}>(`SELECT entity_id AS id,
      (array_agg(entity_name ORDER BY metric_date DESC))[1] AS name,campaign_id,
      (max(metric_date) FILTER(WHERE spend>0))::text AS last_spend_day
      FROM marketing.meta_insights_daily WHERE environment=$1 AND ad_account_id=$2 AND entity_level='ad'
      AND metric_date BETWEEN $3::date AND $4::date GROUP BY entity_id,campaign_id ORDER BY entity_id LIMIT 10001`,params.slice(0,4))).rows;
    const delivery=await readDeliverySettings(c,environment);
    if(catalog.length>1000||insights.length>50000||refs.length>50000||sales.length>50000||bindings.length>10000||snapshots.length>20000||stock.length>20000||offers.length>10000||ads.length>10000)throw Error('geography_limit');
    await c.query('COMMIT');
    return {catalog,insights,refs,sales,bindings,snapshots,stock,offers,ads,delivery:delivery?.settings??null};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export type GeoData=Awaited<ReturnType<typeof loadGeographyData>>;
