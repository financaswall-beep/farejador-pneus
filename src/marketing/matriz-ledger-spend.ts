import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import {
  matrizLedgerAmount, postMatrizLedgerTransaction,
} from '../admin/painel/matriz-ledger-posting.js';

export async function reconcileMatrizMarketingSpend(
  client: PoolClient,
  insightId: string,
  reconciliationId: string,
  createdBy = 'system:meta-sync',
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const result = await client.query<{
    environment: 'prod' | 'test'; entity_level: string; entity_id: string;
    entity_name: string | null; campaign_id: string; campaign_name: string | null;
    metric_date: string; spend: string; account_currency: string;
    campaign_scope: 'pending' | 'matrix' | 'external';
  }>(
    `SELECT i.environment,i.entity_level,i.entity_id,i.entity_name,
            i.campaign_id,i.campaign_name,i.metric_date::text,i.spend::text,
            i.account_currency,s.scope AS campaign_scope
       FROM marketing.meta_insights_daily i
       JOIN marketing.campaign_scopes s
         ON s.environment=i.environment
        AND s.ad_account_id=i.ad_account_id
        AND s.campaign_id=i.campaign_id
      WHERE i.id=$1
      FOR UPDATE OF i,s`,
    [insightId],
  );
  const insight = result.rows[0];
  if (!insight || insight.entity_level !== 'campaign'
    || insight.account_currency !== 'BRL') return null;
  const booked = await client.query<{ amount: string }>(
    `SELECT COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END),0)::text amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment=$1 AND t.source_type='marketing.meta_spend.adjustment'
        AND t.metadata->>'insight_id'=$2 AND e.account_code='marketing_expense'`,
    [insight.environment, insightId],
  );
  const rawSpend = matrizLedgerAmount(insight.spend, 'marketing_spend_invalid');
  const current = env.MARKETING_SCOPE_ENFORCEMENT_ENABLED
    ? insight.campaign_scope === 'matrix' ? rawSpend : 0
    : rawSpend;
  const delta = Math.round((current - Number(booked.rows[0]?.amount ?? 0)) * 100) / 100;
  if (delta === 0) return null;
  const amount = Math.abs(delta);
  const increase = delta > 0;
  return postMatrizLedgerTransaction(client, {
    environment: insight.environment,
    sourceType: 'marketing.meta_spend.adjustment',
    sourceId: `${insightId}:${reconciliationId}`,
    kind: increase ? 'marketing_spend_accrual' : 'marketing_spend_correction',
    amount, occurredAt: `${insight.metric_date}T12:00:00-03:00`,
    description: `Meta Ads: ${insight.campaign_name ?? insight.entity_name ?? insight.campaign_id}`,
    createdBy,
    lines: increase ? [
      { account_code: 'marketing_expense', account_class: 'expense', side: 'debit', amount },
      { account_code: 'marketing_payable', account_class: 'liability', side: 'credit', amount },
    ] : [
      { account_code: 'marketing_payable', account_class: 'liability', side: 'debit', amount },
      { account_code: 'marketing_expense', account_class: 'expense', side: 'credit', amount },
    ],
    metadata: {
      insight_id: insightId, reconciliation_id: reconciliationId,
      campaign_id: insight.campaign_id, entity_id: insight.entity_id,
      metric_date: insight.metric_date, currency: insight.account_currency,
      campaign_scope: insight.campaign_scope,
      raw_spend: rawSpend, resulting_spend: current,
    },
  });
}

export async function reconcileMatrizMarketingCampaign(
  client: PoolClient,
  input: {
    environment: 'prod' | 'test';
    adAccountId: string;
    campaignId: string;
    reconciliationId: string;
    createdBy: string;
  },
): Promise<{ scanned: number; posted: number }> {
  if (!env.MATRIZ_CENTRAL_LEDGER || !env.MARKETING_SCOPE_ENFORCEMENT_ENABLED) {
    return { scanned: 0, posted: 0 };
  }
  const result = await client.query<{ id: string }>(
    `SELECT i.id
       FROM marketing.meta_insights_daily i
      WHERE i.environment=$1 AND i.ad_account_id=$2 AND i.campaign_id=$3
        AND i.entity_level='campaign'
      ORDER BY i.metric_date,i.id
      FOR UPDATE OF i`,
    [input.environment, input.adAccountId, input.campaignId],
  );
  let posted = 0;
  for (const row of result.rows) {
    const transactionId = await reconcileMatrizMarketingSpend(
      client,
      row.id,
      input.reconciliationId,
      input.createdBy,
    );
    if (transactionId) posted += 1;
  }
  return { scanned: result.rows.length, posted };
}
