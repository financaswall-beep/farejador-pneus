import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { reconcileMatrizMarketingCampaign } from './matriz-ledger-spend.js';

export type CampaignScope = 'pending' | 'matrix' | 'external';

export interface CampaignScopeRow {
  id: string;
  environment: 'prod' | 'test';
  ad_account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  scope: CampaignScope;
  classification_reason: string | null;
  classified_by: string | null;
  classified_at: string | null;
  updated_at: string;
}

export interface CampaignScopeChangeResult {
  scope: CampaignScopeRow;
  previous_scope: CampaignScope;
  changed: boolean;
  reconciliation: { scanned: number; posted: number };
}

export async function ensureCampaignScope(
  client: PoolClient,
  input: {
    environment: 'prod' | 'test';
    adAccountId: string;
    campaignId: string;
    campaignName?: string | null;
  },
): Promise<CampaignScopeRow> {
  const result = await client.query<CampaignScopeRow>(
    `INSERT INTO marketing.campaign_scopes (
       environment,ad_account_id,campaign_id,campaign_name
     ) VALUES ($1,$2,$3,$4)
     ON CONFLICT (environment,ad_account_id,campaign_id) DO UPDATE
       SET campaign_name=COALESCE(EXCLUDED.campaign_name,
           marketing.campaign_scopes.campaign_name),
           updated_at=CASE
             WHEN EXCLUDED.campaign_name IS DISTINCT FROM
                  marketing.campaign_scopes.campaign_name
             THEN now() ELSE marketing.campaign_scopes.updated_at END
     RETURNING id,environment,ad_account_id,campaign_id,campaign_name,scope,
               classification_reason,classified_by,classified_at::text,
               updated_at::text`,
    [input.environment, input.adAccountId, input.campaignId, input.campaignName ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('marketing_campaign_scope_not_created');
  return row;
}

async function loadCampaignName(
  client: PoolClient,
  environment: 'prod' | 'test',
  adAccountId: string,
  campaignId: string,
): Promise<string | null | undefined> {
  const result = await client.query<{ campaign_name: string | null }>(
    `SELECT campaign_name
       FROM marketing.meta_insights_daily
      WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3
      ORDER BY collected_at DESC,metric_date DESC LIMIT 1`,
    [environment, adAccountId, campaignId],
  );
  return result.rows[0]?.campaign_name;
}

export async function setCampaignScope(
  input: {
    adAccountId: string;
    campaignId: string;
    scope: CampaignScope;
    reason: string;
    actor: string;
    idempotencyKey: string;
  },
  dbPool: Pool = defaultPool,
): Promise<CampaignScopeChangeResult> {
  const client = await dbPool.connect();
  const auditId = randomUUID();
  try {
    await client.query('BEGIN');
    const campaignName = await loadCampaignName(
      client,
      env.FAREJADOR_ENV,
      input.adAccountId,
      input.campaignId,
    );
    if (campaignName === undefined) throw new Error('marketing_campaign_not_found');
    await ensureCampaignScope(client, {
      environment: env.FAREJADOR_ENV,
      adAccountId: input.adAccountId,
      campaignId: input.campaignId,
      campaignName,
    });
    const locked = await client.query<CampaignScopeRow>(
      `SELECT id,environment,ad_account_id,campaign_id,campaign_name,scope,
              classification_reason,classified_by,classified_at::text,
              updated_at::text
         FROM marketing.campaign_scopes
        WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3
        FOR UPDATE`,
      [env.FAREJADOR_ENV, input.adAccountId, input.campaignId],
    );
    const before = locked.rows[0];
    if (!before) throw new Error('marketing_campaign_scope_not_found');
    const changed = before.scope !== input.scope;
    const updated = await client.query<CampaignScopeRow>(
      `UPDATE marketing.campaign_scopes
          SET scope=$4,
              classification_reason=CASE WHEN $4='pending' THEN NULL ELSE $5 END,
              classified_by=CASE WHEN $4='pending' THEN NULL ELSE $6 END,
              classified_at=CASE WHEN $4='pending' THEN NULL ELSE now() END,
              updated_at=CASE WHEN scope IS DISTINCT FROM $4 THEN now() ELSE updated_at END
        WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3
      RETURNING id,environment,ad_account_id,campaign_id,campaign_name,scope,
                classification_reason,classified_by,classified_at::text,
                updated_at::text`,
      [
        env.FAREJADOR_ENV,
        input.adAccountId,
        input.campaignId,
        input.scope,
        input.reason.trim(),
        input.actor,
      ],
    );
    const after = updated.rows[0];
    if (!after) throw new Error('marketing_campaign_scope_not_updated');
    const reconciliation = await reconcileMatrizMarketingCampaign(client, {
      environment: env.FAREJADOR_ENV,
      adAccountId: input.adAccountId,
      campaignId: input.campaignId,
      reconciliationId: auditId,
      createdBy: input.actor,
    });
    await client.query(
      `INSERT INTO audit.events (
         id,environment,domain,entity_table,entity_id,event_type,actor_label,
         idempotency_key,payload_before,payload_after
       ) VALUES ($1,$2,'marketing','marketing.campaign_scopes',$3,
         'marketing_campaign_scope_set',$4,$5,$6::jsonb,$7::jsonb)`,
      [
        auditId,
        env.FAREJADOR_ENV,
        after.id,
        input.actor,
        input.idempotencyKey,
        JSON.stringify({ scope: before.scope }),
        JSON.stringify({
          scope: after.scope,
          reason: input.reason.trim(),
          changed,
          reconciliation,
          ad_account_id: after.ad_account_id,
          campaign_id: after.campaign_id,
        }),
      ],
    );
    await client.query('COMMIT');
    return { scope: after, previous_scope: before.scope, changed, reconciliation };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
