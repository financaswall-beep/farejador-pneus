import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';

export interface AttributionHealth {
  available: boolean;
  referrals: number;
  tracked: number;
  ctwa: number;
  messenger: number;
  instagram: number;
  pending_identity_campaigns?: number;
}

export async function getMarketingAttributionHealth(
  environment: 'prod' | 'test',
  since: string,
  until: string,
  dbPool: Pool,
): Promise<AttributionHealth> {
  try {
    const result = await dbPool.query<{
      referrals: number; tracked: number; ctwa: number; messenger: number;
      instagram: number; pending_identity_campaigns: number;
    }>(
      `SELECT
         count(DISTINCT conversation_id)::int AS referrals,
         count(DISTINCT conversation_id)::int AS tracked,
         count(DISTINCT conversation_id) FILTER (WHERE channel='whatsapp')::int AS ctwa,
         count(DISTINCT conversation_id) FILTER (WHERE channel='messenger')::int AS messenger,
         count(DISTINCT conversation_id) FILTER (WHERE channel='instagram')::int AS instagram,
         (SELECT count(*)::int FROM (
           SELECT d.ad_account_id,d.campaign_id FROM marketing.meta_ad_identities d
             WHERE d.environment=$1 AND d.scope='pending'
           UNION
           SELECT i.ad_account_id,i.campaign_id FROM marketing.meta_insights_daily_scoped i
             WHERE i.environment=$1 AND i.campaign_scope='pending' AND i.spend>0
               AND i.metric_date BETWEEN $2::date AND $3::date
               AND ($4::boolean OR EXISTS (SELECT 1 FROM marketing.meta_identity_accounts a
                 WHERE a.environment=i.environment AND a.ad_account_id=i.ad_account_id))
         ) pending_campaigns) pending_identity_campaigns
       FROM marketing.ad_referrals r
       WHERE environment=$1
         AND (NOT EXISTS (SELECT 1 FROM marketing.meta_identity_accounts WHERE environment=$1)
           OR EXISTS (SELECT 1 FROM marketing.meta_ad_identities d WHERE d.environment=$1
             AND d.ad_id=r.source_id AND d.scope='matrix'))
         AND captured_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND captured_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`,
      [environment, since, until, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED],
    );
    const row = result.rows[0];
    return {
      available: true,
      referrals: Number(row?.referrals ?? 0),
      tracked: Number(row?.tracked ?? row?.referrals ?? 0),
      ctwa: Number(row?.ctwa ?? 0),
      messenger: Number(row?.messenger ?? 0),
      instagram: Number(row?.instagram ?? 0),
      pending_identity_campaigns: Number(row?.pending_identity_campaigns ?? 0),
    };
  } catch {
    return { available: false, referrals: 0, tracked: 0, ctwa: 0, messenger: 0, instagram: 0 };
  }
}
