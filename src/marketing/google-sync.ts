import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { postMatrizLedgerTransaction } from '../admin/painel/matriz-ledger-posting.js';
import { fetchGoogleAds, type GoogleAdsSnapshot } from './google-ads.js';
import { googleAdsSettings } from './google-ads-report.js';
import { validateGoogleAdsConfig, type GoogleAdsConfig } from './google-ads-client.js';

/** Despesa por campanha/dia. O total por anuncio nunca e lancado novamente. */
async function reconcileSpend(client: PoolClient, environment: 'prod' | 'test', account: string, runId: string): Promise<number> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return 0;
  const rows = await client.query<{ id: string; campaign_id: string; name: string; metric_date: string; target: string; booked: string }>(
    `SELECT i.id,i.campaign_id,c.name,i.metric_date::text,i.expected_spend::text target,
       COALESCE(booked.amount,0)::text booked
     FROM marketing.google_spend_expected i
     JOIN marketing.google_campaigns c USING(environment,account_id,campaign_id)
     LEFT JOIN (
       SELECT t.metadata->>'insight_id' insight_id,
         sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END) amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
       WHERE t.environment=$1 AND t.source_type='marketing.google_spend.adjustment'
         AND e.account_code='marketing_expense'
       GROUP BY t.metadata->>'insight_id'
     ) booked ON booked.insight_id=i.id::text
     WHERE i.environment=$1 AND i.account_id=$2
     ORDER BY i.metric_date,i.id`, [environment,account]);
  let posted = 0;
  for (const row of rows.rows) {
    const delta = Math.round((Number(row.target)-Number(row.booked))*100)/100;
    if (!delta) continue;
    const amount = Math.abs(delta), increase = delta > 0;
    await postMatrizLedgerTransaction(client, {
      environment, sourceType:'marketing.google_spend.adjustment', sourceId:`${row.id}:${runId}`,
      kind:increase?'marketing_spend_accrual':'marketing_spend_correction', amount,
      occurredAt:`${row.metric_date}T12:00:00-03:00`, description:`Google Ads: ${row.name}`,
      createdBy:'system:google-sync', lines: [
        {account_code:'marketing_expense',account_class:'expense',side:increase?'debit':'credit',amount},
        {account_code:'marketing_payable',account_class:'liability',side:increase?'credit':'debit',amount},
      ], metadata:{insight_id:row.id,account_id:account,campaign_id:row.campaign_id,
        metric_date:row.metric_date,reconciliation_id:runId,resulting_spend:Number(row.target),currency:'BRL'},
    });
    posted++;
  }
  return posted;
}

/** Um retrato completo substitui a janela; API falhando nao zera valores nem lancamentos. */
export async function syncGoogleAds(options: {dbPool?: Pool; config?: GoogleAdsConfig; snapshot?: GoogleAdsSnapshot;
  financeSince?: string | null; now?: Date} = {}): Promise<{campaigns: number; ads: number; posted: number}> {
  const config = options.config ?? googleAdsSettings().config as GoogleAdsConfig;
  validateGoogleAdsConfig(config);
  const snapshot = options.snapshot ?? await fetchGoogleAds(config,'30d',{includeDetails:true,now:options.now});
  if (!snapshot.campaign_daily || !snapshot.ads || snapshot.account.id!==config.customerId || snapshot.account.currency!=='BRL') {
    throw new Error('google_snapshot_incomplete');
  }
  const client = await (options.dbPool ?? pool).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('google-sync:'||$1))",[config.environment]);
    const account = snapshot.account, since = options.financeSince === undefined ? env.GOOGLE_ADS_FINANCE_SINCE : options.financeSince;
    await client.query(`INSERT INTO marketing.google_accounts(environment,account_id,name,currency,time_zone,scope,finance_since,last_sync_at)
      VALUES($1,$2,$3,'BRL',$4,$5,$6,$7) ON CONFLICT(environment,account_id) DO UPDATE
      SET name=EXCLUDED.name,time_zone=EXCLUDED.time_zone,scope=EXCLUDED.scope,
        finance_since=COALESCE(EXCLUDED.finance_since,marketing.google_accounts.finance_since),
        last_sync_at=EXCLUDED.last_sync_at`,
    [config.environment,account.id,account.name,account.time_zone,config.scope,since ?? null,snapshot.fetched_at]);
    await client.query('UPDATE marketing.google_campaigns SET owned=false WHERE environment=$1 AND account_id=$2',[config.environment,account.id]);
    for (const c of snapshot.campaigns) {
      const owned = config.scope==='account'||config.campaignIds.includes(c.id);
      await client.query(`INSERT INTO marketing.google_campaigns(environment,account_id,campaign_id,name,status,channel_type,owned)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(environment,account_id,campaign_id) DO UPDATE
        SET name=EXCLUDED.name,status=EXCLUDED.status,channel_type=EXCLUDED.channel_type,owned=EXCLUDED.owned`,
      [config.environment,account.id,c.id,c.name,c.status,c.channel_type,owned]);
    }
    for (const ad of snapshot.ads) {
      await client.query(`INSERT INTO marketing.google_ads(environment,account_id,ad_group_id,ad_id,campaign_id,name,status,format,headlines,descriptions,final_url)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
        ON CONFLICT(environment,account_id,ad_group_id,ad_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,
        format=EXCLUDED.format,headlines=EXCLUDED.headlines,descriptions=EXCLUDED.descriptions,final_url=EXCLUDED.final_url`,
      [config.environment,account.id,ad.ad_group_id,ad.ad_id,ad.campaign_id,ad.name,ad.status,ad.format,JSON.stringify(ad.headlines),JSON.stringify(ad.descriptions),ad.final_url]);
    }
    await client.query(`UPDATE marketing.google_insights_daily SET cost_micros=0,impressions=0,clicks=0,conversions=0,collected_at=$5
      WHERE environment=$1 AND account_id=$2 AND metric_date BETWEEN $3::date AND $4::date`,
    [config.environment,account.id,snapshot.period.since,snapshot.period.until,snapshot.fetched_at]);
    const upsert = async (campaign: string, level: string, id: string, day: NonNullable<GoogleAdsSnapshot['campaign_daily']>[number]) => {
      await client.query(`INSERT INTO marketing.google_insights_daily(environment,account_id,campaign_id,entity_level,entity_id,metric_date,cost_micros,impressions,clicks,conversions,collected_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(environment,account_id,entity_level,entity_id,metric_date)
        DO UPDATE SET cost_micros=EXCLUDED.cost_micros,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,
        conversions=EXCLUDED.conversions,collected_at=EXCLUDED.collected_at`,
      [config.environment,account.id,campaign,level,id,day.date,day.cost_micros,day.impressions,day.clicks,day.conversions,snapshot.fetched_at]);
    };
    for (const day of snapshot.campaign_daily) await upsert(day.campaign_id,'campaign',day.campaign_id,day);
    for (const ad of snapshot.ads) for (const day of ad.daily) await upsert(ad.campaign_id,'ad',ad.id,{...day,campaign_id:ad.campaign_id});
    const posted = await reconcileSpend(client,config.environment,account.id,randomUUID());
    await client.query('COMMIT');
    return {campaigns:snapshot.campaigns.length,ads:snapshot.ads.length,posted};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
