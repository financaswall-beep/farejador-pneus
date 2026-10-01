/** Consultas de apresentação da campanha. Não envia nem altera conversões. */
import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { getMetaCreatives, type MetaCreative } from '../../marketing/meta-creatives.js';
import { marketingCreativeConfig } from './queries-marketing-creatives.js';

export async function loadCampaignMedia(ids: string[]): Promise<MetaCreative[]> {
  const config = marketingCreativeConfig();
  if (!config || !ids.length) return [];
  try { return (await getMetaCreatives(config, ids)).ads; }
  catch { return []; }
}

export interface CampaignConversionEvent {
  id: string;
  order_number: string;
  status: string;
  attempts: number;
  sent_at: string | null;
  updated_at: string;
}

export async function loadCampaignConversions(
  campaignId: string, since: string, until: string, db: Pool, adId?: string,
) {
  const base = { enabled: env.MARKETING_CAPI_ENABLED };
  try {
    const result = await db.query<{
      sent: number; pending: number; failed: number; suppressed: number;
      events: CampaignConversionEvent[];
    }>(`WITH events AS (
      SELECT c.id,COALESCE(o.order_number,'#'||left(o.id::text,8)) AS order_number,
             c.status,c.attempts,c.sent_at,c.updated_at
        FROM marketing.capi_outbox c
        JOIN marketing.order_attributions a ON a.environment=c.environment AND a.id=c.attribution_id
        JOIN marketing.ad_referrals r ON r.environment=a.environment AND r.id=a.referral_id
        JOIN commerce.orders o ON o.environment=a.environment AND o.id=a.order_id
       WHERE c.environment=$1
         AND ($6::text IS NULL OR r.source_id=$6)
         AND a.realized_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND a.realized_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND EXISTS (
           SELECT 1 FROM marketing.meta_insights_daily mi
            WHERE mi.environment=c.environment AND mi.campaign_id=$2
              AND mi.entity_id=r.source_id
              AND ($5::text IS NULL OR mi.ad_account_id=$5)
         )
    ) SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
             count(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending,
             count(*) FILTER (WHERE status IN ('failed','dead_letter'))::int AS failed,
             count(*) FILTER (WHERE status='suppressed')::int AS suppressed,
             COALESCE((SELECT jsonb_agg(e ORDER BY e.updated_at DESC,e.id)
               FROM (SELECT * FROM events ORDER BY updated_at DESC,id LIMIT 30) e),'[]') AS events
        FROM events`, [env.FAREJADOR_ENV, campaignId, since, until, env.META_ADS_ACCOUNT_ID ?? null, adId ?? null]);
    const row = result.rows[0];
    if (!row) throw new Error('Consulta sem resultado');
    return { ...base, available: true, ...row };
  } catch {
    return { ...base, available: false, sent: null, pending: null, failed: null,
      suppressed: null, events: [] as CampaignConversionEvent[] };
  }
}
