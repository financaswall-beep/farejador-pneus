/** Fontes somente leitura, sempre escopadas por ambiente, conta e anúncio. */
import type { Pool } from 'pg';

export interface CreativeInsight {
  entity_id: string; entity_name: string | null; campaign_id: string; campaign_name: string | null;
  campaign_scope: string; metric_date: string; account_currency: string;
  spend: unknown; conversations: unknown; impressions: unknown; clicks: unknown; collected_at: string;
}
export interface CreativeAttribution {
  ad_id: string; tracked: number; channels: string[]; sales: number; revenue: number;
}

export async function loadCreativeInsights(db: Pool, environment: string, account: string, since: string, until: string) {
  return (await db.query<CreativeInsight>(
    `SELECT mi.entity_id,mi.entity_name,mi.campaign_id,mi.campaign_name,
            COALESCE(s.scope,'pending') AS campaign_scope,mi.metric_date::text,
            mi.account_currency,mi.spend,mi.conversations,mi.impressions,mi.clicks,mi.collected_at::text
       FROM marketing.meta_insights_daily mi
       LEFT JOIN marketing.campaign_scopes s ON s.environment=mi.environment
        AND s.ad_account_id=mi.ad_account_id AND s.campaign_id=mi.campaign_id
      WHERE mi.environment=$1 AND mi.ad_account_id=$2 AND mi.entity_level='ad'
        AND mi.metric_date BETWEEN $3::date AND $4::date
      ORDER BY mi.metric_date,mi.entity_id`, [environment, account, since, until],
  )).rows;
}

// Uma atribuição ativa por pedido; o estado atual também exclui pedidos cancelados/não realizados.
const VALID_ORDERS = `o.status<>'cancelled' AND (
  (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL AND NOT po.awaiting_pickup
    AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered'))
  OR (po.id IS NULL AND o.status IN ('confirmed','paid','delivered')
    AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')))`;

export async function loadCreativeAttribution(db: Pool, environment: string, account: string, since: string, until: string) {
  return (await db.query<CreativeAttribution>(
    `WITH ads AS (
       SELECT DISTINCT entity_id FROM marketing.meta_insights_daily
        WHERE environment=$1 AND ad_account_id=$2 AND entity_level='ad'
     ), tracked AS (
       SELECT r.source_id,count(DISTINCT r.conversation_id)::int AS tracked,
              array_agg(DISTINCT r.channel) AS channels
         FROM marketing.ad_referrals r JOIN ads ON ads.entity_id=r.source_id
        WHERE r.environment=$1
          AND r.captured_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND r.captured_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY r.source_id
     ), sales AS (
       SELECT r.source_id,count(DISTINCT a.order_id)::int AS sales,COALESCE(sum(o.total_amount),0)::float8 AS revenue
         FROM marketing.order_attributions a
         JOIN marketing.ad_referrals r ON r.environment=a.environment AND r.id=a.referral_id
         JOIN ads ON ads.entity_id=r.source_id
         JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.order_id
         LEFT JOIN commerce.partner_orders po ON po.environment=o.environment AND po.id=o.partner_order_id
        WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL AND ${VALID_ORDERS}
          AND a.realized_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND a.realized_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY r.source_id
     ) SELECT ads.entity_id AS ad_id,COALESCE(t.tracked,0) AS tracked,COALESCE(t.channels,'{}') AS channels,
              COALESCE(s.sales,0) AS sales,COALESCE(s.revenue,0) AS revenue
         FROM ads LEFT JOIN tracked t ON t.source_id=ads.entity_id LEFT JOIN sales s ON s.source_id=ads.entity_id`,
    [environment, account, since, until],
  )).rows;
}

export async function loadCreativeJourneys(db: Pool, environment: string, adId: string, since: string, until: string, includeSales = true) {
  return (await db.query(
    `WITH tracked AS (
       SELECT r.conversation_id,min(r.captured_at) AS captured_at,array_agg(DISTINCT r.channel) AS channels
         FROM marketing.ad_referrals r
        WHERE r.environment=$1 AND r.source_id=$2
          AND r.captured_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND r.captured_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY r.conversation_id
     ), sales AS (
       SELECT r.conversation_id,min(r.captured_at) AS captured_at,max(a.realized_at) AS realized_at,
              array_agg(DISTINCT r.channel) AS channels,
              count(DISTINCT a.order_id)::int AS sales,COALESCE(sum(o.total_amount),0)::float8 AS revenue
         FROM marketing.order_attributions a
         JOIN marketing.ad_referrals r ON r.environment=a.environment AND r.id=a.referral_id
         JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.order_id
         LEFT JOIN commerce.partner_orders po ON po.environment=o.environment AND po.id=o.partner_order_id
        WHERE $5::boolean AND a.environment=$1 AND r.source_id=$2 AND a.status='active' AND a.superseded_by IS NULL AND ${VALID_ORDERS}
          AND a.realized_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND a.realized_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY r.conversation_id
     ) SELECT c.chatwoot_conversation_id AS conversation_id,COALESCE(t.captured_at,s.captured_at)::text AS captured_at,
              COALESCE(t.channels,s.channels) AS channels,
              COALESCE(s.sales,0) AS sales,COALESCE(s.revenue,0) AS revenue
         FROM tracked t FULL JOIN sales s ON s.conversation_id=t.conversation_id
         JOIN core.conversations c ON c.environment=$1 AND c.id=COALESCE(t.conversation_id,s.conversation_id)
        ORDER BY GREATEST(t.captured_at,s.realized_at) DESC,c.id LIMIT 100`, [environment, adId, since, until, includeSales],
  )).rows;
}
