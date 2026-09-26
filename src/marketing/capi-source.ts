/** Fonte comum da CAPI: somente compras recentes o bastante para a Meta aceitar. */
import type { Pool } from 'pg';
import { env } from '../shared/config/env.js';
import { META_BUSINESS_ACCOUNTS } from '../shared/meta-business-accounts.js';

export interface CapiSourceRow {
  attribution_id: string;
  order_number: string;
  total_amount: string;
  realized_at: string;
  phone_e164: string | null;
  channel: 'whatsapp' | 'messenger' | 'instagram';
  ctwa_clid: string | null;
  user_scoped_id: string | null;
  business_account_id: string | null;
  ad_account_id: string | null;
  campaign_id: string | null;
  campaign_scope_id: string | null;
  city_name: string | null;
  state_code: string | null;
  postal_code_prefix: string | null;
}

const CAPI_SOURCE_SQL = `
  SELECT a.id AS attribution_id,o.order_number,o.total_amount::text,
         a.realized_at::text,c.phone_e164,r.channel,r.ctwa_clid,
         r.user_scoped_id,r.business_account_id,
         map.ad_account_id,map.campaign_id,s.id AS campaign_scope_id,
         g.city_name,g.state_code,g.postal_code_prefix
    FROM marketing.order_attributions a
    JOIN marketing.ad_referrals r
      ON r.environment=a.environment AND r.id=a.referral_id
    JOIN commerce.orders o
      ON o.environment=a.environment AND o.id=a.order_id
    LEFT JOIN commerce.partner_orders po
      ON po.environment=o.environment AND po.id=o.partner_order_id
    JOIN core.contacts c
      ON c.environment=o.environment AND c.id=o.contact_id
    LEFT JOIN commerce.geo_resolutions g
      ON g.environment=o.environment AND g.id=o.geo_resolution_id
    LEFT JOIN LATERAL (
      SELECT min(mapped.ad_account_id) AS ad_account_id,
             min(mapped.campaign_id) AS campaign_id
        FROM (
          SELECT DISTINCT mi.ad_account_id,mi.campaign_id
            FROM marketing.meta_insights_daily mi
           WHERE mi.environment=a.environment AND mi.entity_level='ad'
             AND mi.entity_id=r.source_id
        ) mapped
      HAVING count(*)=1
    ) map ON true
    LEFT JOIN marketing.campaign_scopes s
      ON s.environment=a.environment AND s.ad_account_id=map.ad_account_id
     AND s.campaign_id=map.campaign_id
   WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL
     AND o.status<>'cancelled'
     AND (
       (po.id IS NOT NULL AND po.status<>'cancelled' AND po.deleted_at IS NULL
         AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status<>'delivered')
         AND NOT po.awaiting_pickup)
       OR (po.id IS NULL AND o.status IN ('confirmed','paid','delivered')
         AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered'))
     )
     AND (r.channel='whatsapp'
       OR (r.channel='messenger' AND r.business_account_id=$3)
       OR (r.channel='instagram' AND r.business_account_id=$4))
     AND a.realized_at>=now()-interval '6 days 23 hours'
     AND (NOT $2::boolean OR s.scope='matrix')`;

export async function loadProductionCapiSources(dbPool: Pool): Promise<CapiSourceRow[]> {
  const result = await dbPool.query<CapiSourceRow>(
    `${CAPI_SOURCE_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM marketing.capi_outbox q
          WHERE q.environment=a.environment AND q.attribution_id=a.id
            AND q.status<>'suppressed'
       )
     ORDER BY a.realized_at,a.id`,
    [env.FAREJADOR_ENV, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED,
      META_BUSINESS_ACCOUNTS.facebook.id, META_BUSINESS_ACCOUNTS.instagram.id],
  );
  return result.rows;
}

export async function loadLatestCapiTestSource(
  dbPool: Pool,
): Promise<CapiSourceRow | null> {
  const result = await dbPool.query<CapiSourceRow>(
    `${CAPI_SOURCE_SQL}
     ORDER BY a.realized_at DESC,a.id DESC
     LIMIT 1`,
    [env.FAREJADOR_ENV, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED,
      META_BUSINESS_ACCOUNTS.facebook.id, META_BUSINESS_ACCOUNTS.instagram.id],
  );
  return result.rows[0] ?? null;
}
