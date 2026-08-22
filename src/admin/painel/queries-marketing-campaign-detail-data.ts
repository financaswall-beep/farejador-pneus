/** Vendas e referências multicanal de uma campanha, sem dados pessoais do cliente. */
import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';

interface ReferralCountRow {
  referrals: unknown;
}

interface AttributedOrderRow {
  order_number: string;
  realized_at: string;
  referral_captured_at: string;
  source_id: string | null;
  ad_id: string | null;
  revenue: unknown;
  product_cost: unknown;
  operation_cost: unknown;
  gross_margin: unknown;
  cost_complete: boolean;
  time_to_sale_minutes: unknown;
  channel: 'whatsapp' | 'messenger' | 'instagram';
}

export interface CampaignAttributedOrder {
  order_number: string;
  realized_at: string;
  origin: 'WhatsApp' | 'Messenger' | 'Instagram';
  ad_id: string | null;
  revenue: number;
  product_cost: number | null;
  operation_cost: number | null;
  gross_margin: number | null;
  cost_complete: boolean;
  time_to_sale_minutes: number;
  status: 'confirmed';
}

export interface CampaignAttributionDetailData {
  available: boolean;
  referrals: number;
  orders: CampaignAttributedOrder[];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableMoney(value: unknown): number | null {
  if (value == null) return null;
  return Math.round(numberValue(value) * 100) / 100;
}

export async function loadCampaignAttributionDetailData(
  campaignId: string,
  since: string,
  until: string,
  dbPool: Pool,
): Promise<CampaignAttributionDetailData> {
  try {
    const [referrals, orders] = await Promise.all([
      dbPool.query<ReferralCountRow>(
        `SELECT count(*)::int AS referrals
           FROM marketing.ad_referrals r
          WHERE r.environment=$1
            AND r.captured_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
            AND r.captured_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
            AND EXISTS (
              SELECT 1
                FROM marketing.meta_insights_daily mi
               WHERE mi.environment=$1 AND mi.campaign_id=$2
                 AND mi.entity_id=r.source_id
            )`,
        [env.FAREJADOR_ENV, campaignId, since, until],
      ),
      dbPool.query<AttributedOrderRow>(
        `WITH costs AS (
           SELECT oi.order_id,count(*)::int AS item_count,
                  count(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int AS missing_cost,
                  COALESCE(sum(oi.quantity*oi.matriz_unit_cost)
                    FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) AS product_cost
             FROM commerce.order_items oi
            WHERE oi.environment=$1
            GROUP BY oi.order_id
         ),
         attributed AS (
           SELECT a.order_id,a.realized_at,r.captured_at,r.source_id,r.channel,
                  map.entity_level,map.entity_id AS mapped_entity_id,
                  COALESCE(o.order_number,'#'||left(o.id::text,8)) AS order_number,
                  o.total_amount,o.partner_order_id,
                  COALESCE(c.item_count,0) AS item_count,
                  COALESCE(c.missing_cost,0) AS missing_cost,
                  COALESCE(c.product_cost,0) AS direct_product_cost,
                  ce.commission_amount
             FROM marketing.order_attributions a
             JOIN marketing.ad_referrals r
               ON r.environment=a.environment AND r.id=a.referral_id
             JOIN commerce.orders o
               ON o.environment=a.environment AND o.id=a.order_id
             LEFT JOIN costs c ON c.order_id=o.id
             LEFT JOIN network.commission_entries ce
               ON ce.environment=o.environment
              AND ce.partner_order_id=o.partner_order_id
              AND ce.status<>'reversed'
             JOIN LATERAL (
               SELECT mi.entity_level,mi.entity_id
                 FROM marketing.meta_insights_daily mi
                WHERE mi.environment=$1 AND mi.campaign_id=$2
                  AND mi.entity_id=r.source_id
                ORDER BY CASE WHEN mi.entity_level='ad' THEN 0 ELSE 1 END,
                         mi.metric_date DESC,mi.collected_at DESC
                LIMIT 1
             ) map ON true
            WHERE a.environment=$1 AND a.status='active'
              AND a.superseded_by IS NULL
              AND a.realized_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
              AND a.realized_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
         )
         SELECT order_number,realized_at::text,channel,
                captured_at::text AS referral_captured_at,source_id,
                CASE WHEN entity_level='ad' THEN mapped_entity_id END AS ad_id,
                total_amount::float8 AS revenue,
                CASE
                  WHEN partner_order_id IS NOT NULL AND commission_amount IS NOT NULL THEN 0
                  WHEN partner_order_id IS NULL AND item_count>0 AND missing_cost=0
                    THEN direct_product_cost
                  ELSE NULL
                END::float8 AS product_cost,
                CASE
                  WHEN partner_order_id IS NOT NULL AND commission_amount IS NOT NULL
                    THEN total_amount-commission_amount
                  WHEN partner_order_id IS NULL AND item_count>0 AND missing_cost=0 THEN 0
                  ELSE NULL
                END::float8 AS operation_cost,
                CASE
                  WHEN partner_order_id IS NOT NULL THEN commission_amount
                  WHEN item_count>0 AND missing_cost=0
                    THEN total_amount-direct_product_cost
                  ELSE NULL
                END::float8 AS gross_margin,
                CASE
                  WHEN partner_order_id IS NOT NULL THEN commission_amount IS NOT NULL
                  ELSE item_count>0 AND missing_cost=0
                END AS cost_complete,
                GREATEST(0,round(extract(epoch FROM (realized_at-captured_at))/60))
                  AS time_to_sale_minutes
           FROM attributed
          ORDER BY realized_at DESC,order_number DESC`,
        [env.FAREJADOR_ENV, campaignId, since, until],
      ),
    ]);
    return {
      available: true,
      referrals: Math.round(numberValue(referrals.rows[0]?.referrals)),
      orders: orders.rows.map((row) => ({
        order_number: row.order_number,
        realized_at: row.realized_at,
        origin: row.channel === 'instagram'
          ? 'Instagram' as const
          : row.channel === 'messenger'
            ? 'Messenger' as const
            : 'WhatsApp' as const,
        ad_id: row.ad_id,
        revenue: nullableMoney(row.revenue) ?? 0,
        product_cost: nullableMoney(row.product_cost),
        operation_cost: nullableMoney(row.operation_cost),
        gross_margin: nullableMoney(row.gross_margin),
        cost_complete: Boolean(row.cost_complete),
        time_to_sale_minutes: Math.round(numberValue(row.time_to_sale_minutes)),
        status: 'confirmed' as const,
      })),
    };
  } catch {
    return { available: false, referrals: 0, orders: [] };
  }
}
