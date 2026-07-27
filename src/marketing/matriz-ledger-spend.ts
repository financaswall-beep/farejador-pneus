import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import {
  matrizLedgerAmount, postMatrizLedgerTransaction,
} from '../admin/painel/matriz-ledger-posting.js';

export async function reconcileMatrizMarketingSpend(
  client: PoolClient,
  insightId: string,
  syncRunId: string,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const result = await client.query<{
    environment: 'prod' | 'test'; entity_level: string; entity_id: string;
    entity_name: string | null; campaign_id: string; campaign_name: string | null;
    metric_date: string; spend: string; account_currency: string;
  }>(
    `SELECT environment,entity_level,entity_id,entity_name,campaign_id,campaign_name,
            metric_date::text,spend::text,account_currency
       FROM marketing.meta_insights_daily WHERE id=$1`,
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
  const current = matrizLedgerAmount(insight.spend, 'marketing_spend_invalid');
  const delta = Math.round((current - Number(booked.rows[0]?.amount ?? 0)) * 100) / 100;
  if (delta === 0) return null;
  const amount = Math.abs(delta);
  const increase = delta > 0;
  return postMatrizLedgerTransaction(client, {
    environment: insight.environment,
    sourceType: 'marketing.meta_spend.adjustment',
    sourceId: `${insightId}:${syncRunId}`,
    kind: increase ? 'marketing_spend_accrual' : 'marketing_spend_correction',
    amount, occurredAt: `${insight.metric_date}T12:00:00-03:00`,
    description: `Meta Ads: ${insight.campaign_name ?? insight.entity_name ?? insight.campaign_id}`,
    createdBy: 'system:meta-sync',
    lines: increase ? [
      { account_code: 'marketing_expense', account_class: 'expense', side: 'debit', amount },
      { account_code: 'marketing_payable', account_class: 'liability', side: 'credit', amount },
    ] : [
      { account_code: 'marketing_payable', account_class: 'liability', side: 'debit', amount },
      { account_code: 'marketing_expense', account_class: 'expense', side: 'credit', amount },
    ],
    metadata: {
      insight_id: insightId, sync_run_id: syncRunId,
      campaign_id: insight.campaign_id, entity_id: insight.entity_id,
      metric_date: insight.metric_date, currency: insight.account_currency,
      resulting_spend: current,
    },
  });
}
