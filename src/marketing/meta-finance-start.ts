import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { reconcileMatrizMarketingCampaign } from './matriz-ledger-spend.js';
import { clearMetaMarketingCache } from '../admin/painel/marketing-meta.js';

/** A later cutoff cannot hide an existing posting. Reset remains a separate operation. */
export async function setMetaFinanceStart(input: {
  account: string; since: string; reason: string; actor: string; idempotencyKey: string;
}, dbPool: Pool = pool) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`meta-identity:${env.FAREJADOR_ENV}:${input.account}`]);
    const policy = await client.query<{ finance_since: string; today: string }>(`SELECT finance_since::text,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today FROM marketing.meta_identity_accounts
      WHERE environment=$1 AND ad_account_id=$2 FOR UPDATE`, [env.FAREJADOR_ENV, input.account]);
    const before = policy.rows[0];
    if (!before) throw new Error('meta_account_not_found');
    if (input.since > before.today) throw new Error('meta_finance_start_future');
    if (input.since === before.finance_since) { await client.query('COMMIT'); return { since: input.since }; }
    const prior = await client.query(`SELECT 1 FROM finance.matriz_ledger_transactions t
      JOIN marketing.meta_insights_daily i ON i.environment=t.environment AND i.id::text=t.metadata->>'insight_id'
      WHERE t.environment=$1 AND t.source_type='marketing.meta_spend.adjustment' AND i.ad_account_id=$2
        AND i.metric_date<$3::date LIMIT 1`, [env.FAREJADOR_ENV, input.account, input.since]);
    if (input.since > before.finance_since && prior.rows.length) throw new Error('meta_finance_start_has_history');
    await client.query(`UPDATE marketing.meta_identity_accounts SET finance_since=$3::date
      WHERE environment=$1 AND ad_account_id=$2`, [env.FAREJADOR_ENV, input.account, input.since]);
    if (input.since < before.finance_since) await client.query(`UPDATE marketing.meta_ad_identities
      SET metrics_backfill_pending=true WHERE environment=$1 AND ad_account_id=$2 AND scope='matrix'`,
    [env.FAREJADOR_ENV, input.account]);
    const campaigns = await client.query<{ campaign_id: string }>(`SELECT campaign_id FROM marketing.campaign_scopes
      WHERE environment=$1 AND ad_account_id=$2`, [env.FAREJADOR_ENV, input.account]);
    const reconciliationId = randomUUID();
    for (const row of campaigns.rows) await reconcileMatrizMarketingCampaign(client, {
      environment: env.FAREJADOR_ENV, adAccountId: input.account, campaignId: row.campaign_id,
      reconciliationId, createdBy: input.actor,
    });
    await client.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,
      actor_label,idempotency_key,payload_before,payload_after)
      VALUES($1,'marketing','marketing.meta_identity_accounts',$2,'marketing_meta_finance_start_changed',
        $3,$4,$5::jsonb,$6::jsonb)`, [env.FAREJADOR_ENV, reconciliationId, input.actor, input.idempotencyKey,
      JSON.stringify({ account: input.account, since: before.finance_since }),
      JSON.stringify({ account: input.account, since: input.since, reason: input.reason.trim() })]);
    await client.query('COMMIT');
    clearMetaMarketingCache();
    return { since: input.since, sync_required: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
