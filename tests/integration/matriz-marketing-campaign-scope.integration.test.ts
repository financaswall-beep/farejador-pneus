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
    const fetcher = (async (input: URL | RequestInfo) => {
      const level = new URL(String(input)).searchParams.get('level');
      return new Response(JSON.stringify({ data: [{
        campaign_id: 'camp-scope',
        campaign_name: 'Campanha com dono explícito',
        ...(level === 'ad' ? { ad_id: 'ad-scope', ad_name: 'Criativo' } : {}),
        date_start: '2026-07-31',
        spend: '125.50',
        account_currency: 'BRL',
        impressions: '1000',
        clicks: '25',
        actions: [],
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await syncMetaInsights({
      dbPool: db.pool,
      config: { adAccountId: 'act_123', accessToken: 'server-only', apiVersion: 'v21.0' },
      fetcher,
      now: new Date('2026-07-31T20:00:00Z'),
      lookbackDays: 1,
    });

    await expect(loadProductionCapiSources(db.pool)).resolves.toEqual([]);

    expect(await db.pool.query(
      `SELECT scope FROM marketing.campaign_scopes
        WHERE environment='test' AND campaign_id='camp-scope'`,
    ).then((result) => result.rows[0]?.scope)).toBe('pending');
    expect(await db.pool.query(
      `SELECT count(*)::int total FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_type='marketing.meta_spend.adjustment'`,
    ).then((result) => result.rows[0]?.total)).toBe(0);
    expect(await getStage4('test', db.pool)).toMatchObject({
      status: 'yellow',
      total_errors: 0,
      pending_operational: { marketing_campaigns_unclassified: 1 },
    });

    const matrix = await setCampaignScope({
      adAccountId: 'act_123', campaignId: 'camp-scope', scope: 'matrix',
      reason: 'Campanha própria da matriz', actor: 'Wallace', idempotencyKey: 'scope-matrix',
    }, db.pool);
    expect(matrix.reconciliation).toEqual({ scanned: 1, posted: 1 });
    expect((await getStage4('test', db.pool)).status).toBe('green');

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
    expect((await getStage4('test', db.pool)).status).toBe('green');
  });

  it('serializa sincronização e reclassificação concorrentes sem deixar saldo residual', async () => {
    let spend = '80.00';
    const fetcher = (async (input: URL | RequestInfo) => {
      const level = new URL(String(input)).searchParams.get('level');
      return new Response(JSON.stringify({ data: [{
        campaign_id: 'camp-concurrent',
        campaign_name: 'Campanha concorrente',
        ...(level === 'ad' ? { ad_id: 'ad-concurrent', ad_name: 'Criativo concorrente' } : {}),
        date_start: '2026-07-31',
        spend,
        account_currency: 'BRL',
        impressions: '500',
        clicks: '10',
        actions: [],
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await syncMetaInsights({
      dbPool: db.pool,
      config: { adAccountId: 'act_123', accessToken: 'server-only', apiVersion: 'v21.0' },
      fetcher,
      now: new Date('2026-07-31T20:00:00Z'),
      lookbackDays: 1,
    });
    await setCampaignScope({
      adAccountId: 'act_123', campaignId: 'camp-concurrent', scope: 'matrix',
      reason: 'Classificação inicial da matriz', actor: 'Wallace',
      idempotencyKey: 'scope-concurrent-matrix',
    }, db.pool);

    spend = '150.00';
    await Promise.all([
      syncMetaInsights({
        dbPool: db.pool,
        config: { adAccountId: 'act_123', accessToken: 'server-only', apiVersion: 'v21.0' },
        fetcher,
        now: new Date('2026-07-31T20:05:00Z'),
        lookbackDays: 1,
      }),
      setCampaignScope({
        adAccountId: 'act_123', campaignId: 'camp-concurrent', scope: 'external',
        reason: 'Reclassificação concorrente para operação externa', actor: 'Wallace',
        idempotencyKey: 'scope-concurrent-external',
      }, db.pool),
    ]);

    const proof = await db.pool.query<{
      scope: string; booked_expense: string; duplicate_sources: number;
    }>(
      `SELECT
         (SELECT scope FROM marketing.campaign_scopes
           WHERE environment='test' AND ad_account_id='act_123'
             AND campaign_id='camp-concurrent') scope,
         (SELECT COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END),0)::text
            FROM finance.matriz_ledger_entries e
            JOIN finance.matriz_ledger_transactions t ON t.id=e.transaction_id
           WHERE t.environment='test' AND e.account_code='marketing_expense'
             AND t.metadata->>'campaign_id'='camp-concurrent') booked_expense,
         (SELECT count(*)::int FROM (
           SELECT source_type,source_id
             FROM finance.matriz_ledger_transactions
            WHERE environment='test' AND metadata->>'campaign_id'='camp-concurrent'
            GROUP BY source_type,source_id HAVING count(*)>1
         ) duplicated) duplicate_sources`,
    );
    expect(proof.rows[0]).toEqual({
      scope: 'external', booked_expense: '0.00', duplicate_sources: 0,
    });
    expect(await getStage4('test', db.pool)).toMatchObject({
      status: 'green', total_errors: 0,
      pending_operational: { marketing_campaigns_unclassified: 0 },
    });
  }, 30_000);
});
