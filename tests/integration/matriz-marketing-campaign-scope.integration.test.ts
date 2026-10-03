import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Marketing — escopo financeiro, histórico e ledger', () => {
  let db: IntegrationDb;
  let syncMetaInsights:
    typeof import('../../src/marketing/meta-sync.js').syncMetaInsights;
  let setCampaignScope:
    typeof import('../../src/marketing/campaign-scope.js').setCampaignScope;
  let loadProductionCapiSources:
    typeof import('../../src/marketing/capi-source.js').loadProductionCapiSources;
  let getStage4:
    typeof import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js').getMatrizStage4LedgerReconciliation;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'test-admin-token',
      MATRIZ_CENTRAL_LEDGER: 'true',
      MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ syncMetaInsights } = await import('../../src/marketing/meta-sync.js'));
    ({ setCampaignScope } = await import('../../src/marketing/campaign-scope.js'));
    ({ loadProductionCapiSources } = await import('../../src/marketing/capi-source.js'));
    ({ getMatrizStage4LedgerReconciliation: getStage4 } = await import(
      '../../src/admin/painel/matriz-ledger-stage4-reconciliation.js'
    ));
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
    process.env.MARKETING_SCOPE_ENFORCEMENT_ENABLED = 'false';
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  it('pending não contabiliza, matrix provisiona e external estorna sem apagar histórico', async () => {
    // Legacy data keeps its manual workflow until identity sync is activated for this account.
    await db.pool.query(`INSERT INTO marketing.meta_insights_daily
      (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,campaign_name,metric_date,spend,impressions,clicks,actions_raw)
      VALUES ('test','act_123','v26.0','BRL','campaign','camp-scope','camp-scope','Campanha com dono explícito','2026-07-31',125.50,1000,25,'[]'),
        ('test','act_123','v26.0','BRL','ad','ad-scope','camp-scope','Campanha com dono explícito','2026-07-31',125.50,1000,25,'[]')`);

    await expect(loadProductionCapiSources(db.pool)).resolves.toEqual([]);

    expect(await db.pool.query(
      `SELECT scope FROM marketing.campaign_scopes
        WHERE environment='test' AND campaign_id='camp-scope'`,
    ).then((result) => result.rows[0]?.scope)).toBe('pending');
    expect(await db.pool.query(
      `SELECT count(*)::int total FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_type='marketing.meta_spend.adjustment'`,
    ).then((result) => result.rows[0]?.total)).toBe(0);
    expect(await getStage4('test', db.pool, { since: '2026-07-01', until: '2026-07-31' })).toMatchObject({
      status: 'yellow',
      total_errors: 0,
      pending_operational: { marketing_campaigns_unclassified: 1 },
    });

    const matrix = await setCampaignScope({
      adAccountId: 'act_123', campaignId: 'camp-scope', scope: 'matrix',
      reason: 'Campanha própria da matriz', actor: 'Wallace', idempotencyKey: 'scope-matrix',
    }, db.pool);
    expect(matrix.reconciliation).toEqual({ scanned: 1, posted: 1 });
    expect((await getStage4('test', db.pool, { since: '2026-07-01', until: '2026-07-31' })).status).toBe('green');

    const external = await setCampaignScope({
      adAccountId: 'act_123', campaignId: 'camp-scope', scope: 'external',
      reason: 'Campanha de operação externa', actor: 'Wallace', idempotencyKey: 'scope-external',
    }, db.pool);
    expect(external.reconciliation).toEqual({ scanned: 1, posted: 1 });

    const proof = await db.pool.query<{
      transactions: number; expense: string; payable: string; audit_events: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='marketing.meta_spend.adjustment') transactions,
         (SELECT COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END),0)::text
            FROM finance.matriz_ledger_entries e
            JOIN finance.matriz_ledger_transactions t ON t.id=e.transaction_id
           WHERE t.environment='test' AND e.account_code='marketing_expense') expense,
         (SELECT COALESCE(sum(CASE e.side WHEN 'credit' THEN e.amount ELSE -e.amount END),0)::text
            FROM finance.matriz_ledger_entries e
            JOIN finance.matriz_ledger_transactions t ON t.id=e.transaction_id
           WHERE t.environment='test' AND e.account_code='marketing_payable') payable,
         (SELECT count(*)::int FROM audit.events
           WHERE environment='test' AND event_type='marketing_campaign_scope_set') audit_events`,
    );
    expect(proof.rows[0]).toEqual({
      transactions: 2, expense: '0.00', payable: '0.00', audit_events: 2,
    });
    expect((await getStage4('test', db.pool, { since: '2026-07-01', until: '2026-07-31' })).status).toBe('green');
  });
});
