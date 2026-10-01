/** Detalha o mesmo conjunto de vendas usado pelos indicadores dos anúncios. */
import type { Pool } from 'pg';
import { REALIZED_CTE } from '../../marketing/reporting.js';

export interface AdOrder {
  id: string;
  order_number: string;
  realized_at: string;
  conversation_id: number;
  account_id: number;
  channel: string;
  revenue: number;
  product_cost: number | null;
  operation_cost: number | null;
  gross_margin: number | null;
  conversion_status: string | null;
}
interface AdOrdersResult {
  available: boolean;
  total: number | null;
  product_cost: number | null;
  operation_cost: number | null;
  rows: AdOrder[];
}
export async function loadMarketingAdOrders(
  db: Pool, environment: string, account: string, adId: string,
  since: string, until: string, enforceScope: boolean,
): Promise<AdOrdersResult> {
  try {
    const result = await db.query<Omit<AdOrdersResult, 'available'>>(`${REALIZED_CTE}, matched AS (
      SELECT a.order_id AS id,COALESCE(o.order_number,'#'||left(o.id::text,8)) AS order_number,
             a.realized_at,c.chatwoot_conversation_id AS conversation_id,c.chatwoot_account_id AS account_id,
             r.channel,a.total_amount::float8 AS revenue,a.gross_margin::float8,
             CASE WHEN a.gross_margin IS NULL THEN NULL WHEN a.partner_order_id IS NULL
               THEN a.total_amount-a.gross_margin ELSE 0 END::float8 AS product_cost,
             CASE WHEN a.gross_margin IS NULL THEN NULL WHEN a.partner_order_id IS NOT NULL
               THEN a.total_amount-a.gross_margin ELSE 0 END::float8 AS operation_cost,
             cap.status AS conversion_status
        FROM attributed a
        JOIN realized valid ON valid.id=a.order_id
        JOIN commerce.orders o ON o.environment=$1 AND o.id=a.order_id
        JOIN marketing.ad_referrals r ON r.environment=$1 AND r.id=a.referral_id
        JOIN core.conversations c ON c.environment=$1 AND c.id=r.conversation_id
        LEFT JOIN LATERAL (
          SELECT status FROM marketing.capi_outbox
           WHERE environment=$1 AND attribution_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1
        ) cap ON true
       WHERE a.ad_account_id=$5 AND a.source_id=$6
    ) SELECT count(*)::int AS total,
             CASE WHEN count(*) FILTER (WHERE gross_margin IS NULL)=0
               THEN COALESCE(sum(product_cost),0)::float8 END AS product_cost,
             CASE WHEN count(*) FILTER (WHERE gross_margin IS NULL)=0
               THEN COALESCE(sum(operation_cost),0)::float8 END AS operation_cost,
             COALESCE((SELECT jsonb_agg(entry ORDER BY entry.realized_at DESC,entry.id)
               FROM (SELECT * FROM matched ORDER BY realized_at DESC,id LIMIT 100) entry),'[]') AS rows
        FROM matched`, [environment, since, until, enforceScope, account, adId]);
    return { available: true, ...result.rows[0]! };
  } catch {
    return { available: false, total: null, product_cost: null, operation_cost: null, rows: [] };
  }
}
