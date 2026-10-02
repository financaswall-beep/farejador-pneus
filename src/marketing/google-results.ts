import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { REALIZED_ORDERS_CTE } from './reporting.js';
import { googleConversionHealth } from './google-conversions.js';

export const GOOGLE_RESULTS_CTE = `${REALIZED_ORDERS_CTE}, attributed AS (
  SELECT a.id,a.order_id,a.realized_at,g.campaign_id,g.ad_group_id||':'||g.ad_id ad_id,
    o.total_amount,o.partner_order_id,a.conversation_id,
    CASE WHEN o.partner_order_id IS NOT NULL THEN 0
      WHEN COALESCE(c.item_count,0)>0 AND COALESCE(c.missing_cost,0)=0
        THEN COALESCE(c.cost_total,0) ELSE NULL END product_cost,
    CASE WHEN o.partner_order_id IS NOT NULL THEN o.total_amount-ce.commission_amount
      ELSE 0 END partner_payout,
    CASE WHEN o.partner_order_id IS NOT NULL THEN ce.commission_amount
      WHEN COALESCE(c.item_count,0)>0 AND COALESCE(c.missing_cost,0)=0
        THEN o.total_amount-COALESCE(c.cost_total,0) ELSE NULL END gross_margin
  FROM marketing.google_order_attributions a
  JOIN realized r ON r.id=a.order_id
  JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.order_id
  JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
  JOIN marketing.google_campaigns p ON p.environment=g.environment AND p.account_id=g.account_id AND p.campaign_id=g.campaign_id
  LEFT JOIN costs c ON c.order_id=o.id
  LEFT JOIN network.commission_entries ce ON ce.environment=o.environment AND ce.partner_order_id=o.partner_order_id AND ce.status<>'reversed'
  WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL AND p.owned AND g.account_id=$4
    AND a.realized_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND a.realized_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
)`;
export interface GoogleResult {
  id:string; attributed_sales:number; attributed_revenue:number; gross_margin:number|null;
  product_cost:number|null; partner_payout:number|null;
  pending_margin_orders:number; tracked_conversations:number;
}
export async function getGoogleResults(account: string, since: string, until: string, dbPool: Pool = pool) {
  const environment = env.FAREJADOR_ENV;
  const values = [environment,since,until,account];
  const sales = await dbPool.query<Record<string,unknown>>(`${GOOGLE_RESULTS_CTE}
    SELECT 'campaign' level,campaign_id id,count(*)::int attributed_sales,sum(total_amount) attributed_revenue,
      CASE WHEN count(*) FILTER(WHERE gross_margin IS NULL)>0 THEN NULL ELSE sum(gross_margin) END gross_margin,
      count(*) FILTER(WHERE gross_margin IS NULL)::int pending_margin_orders,
      CASE WHEN count(*) FILTER(WHERE product_cost IS NULL)>0 THEN NULL ELSE sum(product_cost) END product_cost,
      CASE WHEN count(*) FILTER(WHERE partner_payout IS NULL)>0 THEN NULL ELSE sum(partner_payout) END partner_payout
      FROM attributed GROUP BY campaign_id
    UNION ALL SELECT 'ad',ad_id,count(*)::int,sum(total_amount),
      CASE WHEN count(*) FILTER(WHERE gross_margin IS NULL)>0 THEN NULL ELSE sum(gross_margin) END,
      count(*) FILTER(WHERE gross_margin IS NULL)::int,
      CASE WHEN count(*) FILTER(WHERE product_cost IS NULL)>0 THEN NULL ELSE sum(product_cost) END,
      CASE WHEN count(*) FILTER(WHERE partner_payout IS NULL)>0 THEN NULL ELSE sum(partner_payout) END
      FROM attributed GROUP BY ad_id`,values);
  const conversations = await dbPool.query<{campaign_id:string;ad_id:string;count:number}>(
    `SELECT g.campaign_id,g.ad_group_id||':'||g.ad_id ad_id,count(DISTINCT b.conversation_id)::int count
     FROM marketing.google_clicks g JOIN marketing.google_click_conversations b ON b.environment=g.environment AND b.click_id=g.id
     JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
     WHERE g.environment=$1 AND g.account_id=$4 AND c.owned AND b.observed_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND b.observed_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') GROUP BY g.campaign_id,g.ad_group_id,g.ad_id`,values);
  const campaign = new Map<string,GoogleResult>(), ads = new Map<string,GoogleResult>();
  const empty = (id:string):GoogleResult => ({id,attributed_sales:0,attributed_revenue:0,gross_margin:0,
    product_cost:0,partner_payout:0,pending_margin_orders:0,tracked_conversations:0});
  for (const r of sales.rows) {
    const id = String(r.id), row = {...empty(id),attributed_sales:Number(r.attributed_sales),attributed_revenue:Number(r.attributed_revenue),
      gross_margin:r.gross_margin==null?null:Number(r.gross_margin),pending_margin_orders:Number(r.pending_margin_orders),
      product_cost:r.product_cost==null?null:Number(r.product_cost),partner_payout:r.partner_payout==null?null:Number(r.partner_payout)};
    (r.level==='campaign'?campaign:ads).set(id,row);
  }
  for (const r of conversations.rows) {
    const a = ads.get(r.ad_id) ?? empty(r.ad_id); a.tracked_conversations=r.count; ads.set(r.ad_id,a);
  }
  // Campanha conta conversas distintas mesmo quando houve varios anuncios na mesma conversa.
  const campaignsTracked = await dbPool.query<{id:string|null;count:number}>(
    `SELECT g.campaign_id id,count(DISTINCT b.conversation_id)::int count
     FROM marketing.google_clicks g JOIN marketing.google_click_conversations b ON b.environment=g.environment AND b.click_id=g.id
     JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
     WHERE g.environment=$1 AND g.account_id=$4 AND c.owned AND b.observed_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND b.observed_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
     GROUP BY GROUPING SETS ((g.campaign_id),())`,values);
  for (const r of campaignsTracked.rows) {
    if (r.id == null) continue;
    const c=campaign.get(r.id)??empty(r.id);c.tracked_conversations=r.count;campaign.set(r.id,c);
  }
  const orders = await dbPool.query(`${GOOGLE_RESULTS_CTE} SELECT a.order_id,a.campaign_id,a.ad_id,a.total_amount::text revenue,
    a.gross_margin::text gross_margin,a.realized_at,c.chatwoot_conversation_id conversation_number,
    q.status conversion_status FROM attributed a
    JOIN core.conversations c ON c.environment=$1 AND c.id=a.conversation_id
    LEFT JOIN marketing.google_conversion_outbox q ON q.environment=$1 AND q.attribution_id=a.id AND q.action_id=$5
    ORDER BY a.realized_at DESC,a.order_id LIMIT 100`,[...values,env.GOOGLE_ADS_CONVERSION_ACTION_ID??'']);
  const health = await dbPool.query(`SELECT a.last_sync_at,a.finance_since,
    (SELECT jsonb_object_agg(status,n) FROM(SELECT q.status,count(*)::int n FROM marketing.google_conversion_outbox q
       JOIN marketing.google_order_attributions t ON t.id=q.attribution_id AND t.environment=q.environment
       JOIN marketing.google_clicks g ON g.environment=t.environment AND g.id=t.click_id
       WHERE q.environment=$1 AND g.account_id=$2 GROUP BY q.status) s) conversions
    FROM marketing.google_accounts a WHERE a.environment=$1 AND a.account_id=$2`,[environment,account]);
  // Contadores do período acompanham a venda atribuída, sem incluir outras contas ou ações.
  const delivery = await dbPool.query<{campaign_id:string;ad_id:string|null;status:string;count:number;last_sent_at:string|null}>(
    `SELECT g.campaign_id,g.ad_group_id||':'||g.ad_id ad_id,q.status,count(*)::int count,max(q.sent_at)::text last_sent_at
     FROM marketing.google_order_attributions a
     JOIN marketing.google_clicks g ON g.environment=a.environment AND g.id=a.click_id
     JOIN marketing.google_campaigns c ON c.environment=g.environment AND c.account_id=g.account_id AND c.campaign_id=g.campaign_id
     JOIN marketing.google_conversion_outbox q ON q.environment=a.environment AND q.attribution_id=a.id AND q.action_id=$5
     WHERE a.environment=$1 AND g.account_id=$4 AND c.owned
       AND a.realized_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND a.realized_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
     GROUP BY g.campaign_id,g.ad_group_id,g.ad_id,q.status`,[...values,env.GOOGLE_ADS_CONVERSION_ACTION_ID??'']);
  const emptyPipeline = () => ({available:true,pending:0,processing:0,accepted:0,sent:0,failed:0,
    dead_letter:0,review:0,suppressed:0,last_sent_at:null as string|null});
  const pipeline = emptyPipeline();
  const campaignPipelines:Record<string,ReturnType<typeof emptyPipeline>> = {};
  const adPipelines:Record<string,ReturnType<typeof emptyPipeline>> = {};
  for (const row of delivery.rows) {
    const campaignPipeline = campaignPipelines[row.campaign_id] ??= emptyPipeline();
    const targets = [pipeline,campaignPipeline];
    if (row.ad_id) targets.push(adPipelines[row.ad_id] ??= emptyPipeline());
    for (const target of targets) {
      const state = row.status as keyof typeof pipeline;
      if (state !== 'available' && state !== 'last_sent_at' && state in target) target[state] += row.count;
      if (row.last_sent_at && (!target.last_sent_at || Date.parse(row.last_sent_at)>Date.parse(target.last_sent_at))) {
        target.last_sent_at=row.last_sent_at;
      }
    }
  }
  const rows = [...campaign.values()];
  const total = {attributed_sales:rows.reduce((s,r)=>s+r.attributed_sales,0),attributed_revenue:rows.reduce((s,r)=>s+r.attributed_revenue,0),
    gross_margin:rows.some(r=>r.gross_margin==null)?null:rows.reduce((s,r)=>s+(r.gross_margin??0),0),
    pending_margin_orders:rows.reduce((s,r)=>s+r.pending_margin_orders,0),
    tracked_conversations:campaignsTracked.rows.find(row=>row.id==null)?.count??0};
  return {available:true,campaigns:[...campaign.values()],ads:[...ads.values()],totals:total,orders:orders.rows,health:health.rows[0]??null,
    pipeline,campaign_pipelines:campaignPipelines,ad_pipelines:adPipelines,
    conversions_enabled:env.GOOGLE_ADS_CONVERSIONS_ENABLED,conversion_action_configured:!!env.GOOGLE_ADS_CONVERSION_ACTION_ID,
    conversion_destination:googleConversionHealth()};
}
