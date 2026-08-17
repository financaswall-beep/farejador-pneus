import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';

export interface CampaignAttribution {
  campaign_id: string;
  attributed_sales: number;
  attributed_revenue: number;
  gross_margin: number | null;
  pending_margin_orders: number;
}

export interface MarketingAttributionReport {
  available: boolean;
  referrals: number;
  total_realized_orders: number;
  orders_with_conversation: number;
  attributed_sales: number;
  attributed_revenue: number;
  gross_margin: number | null;
  pending_margin_orders: number;
  campaigns: CampaignAttribution[];
}

export interface MarketingPipelineHealth {
  available: boolean;
  last_sync_at: string | null;
  last_sync_status: 'running' | 'succeeded' | 'failed' | null;
  rows_upserted: number;
  capi: {
    pending: number;
    sent: number;
    failed: number;
    dead_letter: number;
    suppressed: number;
  };
}

interface AttributionRow {
  referrals: unknown;
  total_realized_orders: unknown;
  orders_with_conversation: unknown;
  attributed_sales: unknown;
  attributed_revenue: unknown;
  gross_margin: unknown;
  pending_margin_orders: unknown;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const REALIZED_CTE = `
  WITH realized AS (
    SELECT o.id,o.source_conversation_id,
      CASE
        WHEN po.id IS NOT NULL AND po.fulfillment_mode='delivery'
          THEN COALESCE(po.delivered_at,po.created_at)
        WHEN po.id IS NOT NULL THEN COALESCE(po.retrieved_at,po.created_at)
        WHEN o.fulfillment_mode='delivery'
          THEN COALESCE(o.delivered_at,o.closed_at,o.created_at)
        ELSE o.created_at
      END AS realized_at
    FROM commerce.orders o
    LEFT JOIN commerce.partner_orders po
      ON po.environment=o.environment AND po.id=o.partner_order_id
    WHERE o.environment=$1 AND o.status<>'cancelled'
      AND (
        (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL
          AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
          AND NOT po.awaiting_pickup)
        OR
        (po.id IS NULL AND o.status IN ('confirmed','paid','delivered')
          AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered'))
      )
  ),
  costs AS (
    SELECT oi.order_id,count(*)::int AS item_count,
      count(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int AS missing_cost,
      sum(oi.quantity*oi.matriz_unit_cost) FILTER
        (WHERE oi.matriz_unit_cost IS NOT NULL) AS cost_total
    FROM commerce.order_items oi
    WHERE oi.environment=$1
    GROUP BY oi.order_id
  ),
  active_attribution AS (
    SELECT a.id,a.order_id,a.referral_id,a.realized_at,r.source_id
    FROM marketing.order_attributions a
    JOIN marketing.ad_referrals r
      ON r.environment=a.environment AND r.id=a.referral_id
    WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL
      AND a.realized_at>=$2::date AND a.realized_at<($3::date+1)
  ),
  attributed_resolved AS (
    SELECT aa.*,o.total_amount,o.partner_order_id,
      CASE
        WHEN o.partner_order_id IS NOT NULL THEN ce.commission_amount
        WHEN COALESCE(c.item_count,0)>0 AND COALESCE(c.missing_cost,0)=0
          THEN o.total_amount-COALESCE(c.cost_total,0)
        ELSE NULL
      END AS gross_margin,map.ad_account_id,map.campaign_id
    FROM active_attribution aa
    JOIN commerce.orders o ON o.environment=$1 AND o.id=aa.order_id
    LEFT JOIN costs c ON c.order_id=o.id
    LEFT JOIN network.commission_entries ce
      ON ce.environment=o.environment AND ce.partner_order_id=o.partner_order_id
      AND ce.status<>'reversed'
    LEFT JOIN LATERAL (
      SELECT mi.ad_account_id,mi.campaign_id
        FROM marketing.meta_insights_daily mi
       WHERE mi.environment=$1 AND mi.entity_id=aa.source_id
         AND mi.entity_level IN ('ad','campaign')
       ORDER BY CASE WHEN mi.entity_level='ad' THEN 0 ELSE 1 END,
                mi.metric_date DESC,mi.collected_at DESC
       LIMIT 1
    ) map ON true
  ),
  attributed AS (
    SELECT ar.* FROM attributed_resolved ar
     WHERE NOT $4::boolean OR EXISTS (
       SELECT 1 FROM marketing.campaign_scopes s
        WHERE s.environment=$1 AND s.ad_account_id=ar.ad_account_id
          AND s.campaign_id=ar.campaign_id AND s.scope='matrix'
     )
  )`;

export async function getMarketingAttributionReport(
  since: string,
  until: string,
  dbPool: Pool = defaultPool,
): Promise<MarketingAttributionReport> {
  try {
    const [summary, campaigns] = await Promise.all([
      dbPool.query<AttributionRow>(
        `${REALIZED_CTE}
         SELECT
           (SELECT count(*) FROM marketing.ad_referrals
             WHERE environment=$1 AND captured_at>=$2::date
               AND captured_at<($3::date+1))::int AS referrals,
           (SELECT count(*) FROM realized
             WHERE realized_at>=$2::date AND realized_at<($3::date+1))::int
             AS total_realized_orders,
           (SELECT count(*) FROM realized
             WHERE source_conversation_id IS NOT NULL
               AND realized_at>=$2::date AND realized_at<($3::date+1))::int
             AS orders_with_conversation,
           count(*)::int AS attributed_sales,
           COALESCE(sum(total_amount),0) AS attributed_revenue,
           sum(gross_margin) AS gross_margin,
           count(*) FILTER (WHERE gross_margin IS NULL)::int AS pending_margin_orders
         FROM attributed`,
        [env.FAREJADOR_ENV, since, until, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED],
      ),
      dbPool.query<CampaignAttribution>(
        `${REALIZED_CTE}
         SELECT campaign_id,count(*)::int AS attributed_sales,
                COALESCE(sum(total_amount),0)::float8 AS attributed_revenue,
                sum(gross_margin)::float8 AS gross_margin,
                count(*) FILTER (WHERE gross_margin IS NULL)::int AS pending_margin_orders
         FROM attributed
         WHERE campaign_id IS NOT NULL
         GROUP BY campaign_id`,
        [env.FAREJADOR_ENV, since, until, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED],
      ),
    ]);
    const row = summary.rows[0];
    const pending = num(row?.pending_margin_orders);
    return {
      available: true,
      referrals: num(row?.referrals),
      total_realized_orders: num(row?.total_realized_orders),
      orders_with_conversation: num(row?.orders_with_conversation),
      attributed_sales: num(row?.attributed_sales),
      attributed_revenue: Math.round(num(row?.attributed_revenue) * 100) / 100,
      gross_margin: pending === 0 && row?.gross_margin != null
        ? Math.round(num(row.gross_margin) * 100) / 100
        : null,
      pending_margin_orders: pending,
      campaigns: campaigns.rows.map((campaign) => ({
        ...campaign,
        attributed_sales: num(campaign.attributed_sales),
        attributed_revenue: Math.round(num(campaign.attributed_revenue) * 100) / 100,
        gross_margin: num(campaign.pending_margin_orders) === 0 && campaign.gross_margin != null
          ? Math.round(num(campaign.gross_margin) * 100) / 100
          : null,
        pending_margin_orders: num(campaign.pending_margin_orders),
      })),
    };
  } catch {
    return {
      available: false,
      referrals: 0,
      total_realized_orders: 0,
      orders_with_conversation: 0,
      attributed_sales: 0,
      attributed_revenue: 0,
      gross_margin: null,
      pending_margin_orders: 0,
      campaigns: [],
    };
  }
}

export async function getMarketingPipelineHealth(
  dbPool: Pool = defaultPool,
): Promise<MarketingPipelineHealth> {
  try {
    const [sync, capi] = await Promise.all([
      dbPool.query<{
        finished_at: string | null;
        started_at: string;
        status: 'running' | 'succeeded' | 'failed';
        rows_upserted: number;
      }>(
        `SELECT finished_at::text,started_at::text,status,rows_upserted
           FROM marketing.meta_sync_runs
          WHERE environment=$1 ORDER BY started_at DESC LIMIT 1`,
        [env.FAREJADOR_ENV],
      ),
      dbPool.query<{ status: string; total: number }>(
        `SELECT status,count(*)::int AS total FROM marketing.capi_outbox
          WHERE environment=$1 GROUP BY status`,
        [env.FAREJADOR_ENV],
      ),
    ]);
    const last = sync.rows[0];
    const count = (status: string) => num(capi.rows.find((row) => row.status === status)?.total);
    return {
      available: true,
      last_sync_at: last?.finished_at ?? last?.started_at ?? null,
      last_sync_status: last?.status ?? null,
      rows_upserted: num(last?.rows_upserted),
      capi: {
        pending: count('pending') + count('processing'),
        sent: count('sent'),
        failed: count('failed'),
        dead_letter: count('dead_letter'),
        suppressed: count('suppressed'),
      },
    };
  } catch {
    return {
      available: false,
      last_sync_at: null,
      last_sync_status: null,
      rows_upserted: 0,
      capi: { pending: 0, sent: 0, failed: 0, dead_letter: 0, suppressed: 0 },
    };
  }
}
