import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('identidade Meta, campanha mista e financeiro', () => {
  let db: IntegrationDb;
  let sync: typeof import('../../src/marketing/meta-sync.js').syncMetaInsights;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin', MATRIZ_CENTRAL_LEDGER: 'true',
      MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'false' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ syncMetaInsights: sync } = await import('../../src/marketing/meta-sync.js'));
  }, 240_000);
  afterAll(async () => {
    if (db) await stopPostgres(db);
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
  });
  const config = { adAccountId: 'act_123', accessToken: 'test-only', apiVersion: 'v26.0' };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ads')) return Response.json({ data: [
      { id: '111', campaign_id: '10', creative: { actor_id: '1434857906367394' } },
      { id: '112', campaign_id: '10', creative: { instagram_user_id: '17841465774227389' } },
      { id: '113', campaign_id: '10', creative: { actor_id: '999' } },
    ] });
    return Response.json({ data: ['111','112'].map((id, n) => ({ ad_id: id, campaign_id: '10',
      campaign_name: 'Campanha mista', ad_name: id, date_start: '2026-09-29', account_currency: 'BRL',
      spend: n ? '20.00' : '30.00', impressions: '100', clicks: '10', reach: '75',
      actions: [{ action_type: n ? 'lead' : 'onsite_conversion.messaging_conversation_started_7d', value: '2' }],
    })) });
  }) as typeof fetch;
  it('soma só R$ 50 da 2W; mantém R$ 40 externos no histórico; recolher não duplica', async () => {
    await db.pool.query(`INSERT INTO marketing.meta_insights_daily
      (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend,impressions,clicks,conversations,actions_raw)
      VALUES ('test','act_123','v26.0','BRL','ad','113','10','2026-09-29',40,100,10,3,'[]')`);
    for (let n = 0; n < 2; n++) await sync({ dbPool: db.pool, config, fetcher, now: new Date('2026-09-30T12:00:00Z'), lookbackDays: 2 });
    const rows = (await db.pool.query(`SELECT entity_level,entity_id,spend::text,financial_spend::text,campaign_scope,conversations,reach
      FROM marketing.meta_insights_daily_scoped WHERE environment='test' ORDER BY entity_id`)).rows;
    expect(rows.find(r => r.entity_level === 'campaign')).toMatchObject({ spend: '50.00', financial_spend: '50.00', campaign_scope: 'matrix', conversations: 4, reach: null });
    expect(rows.find(r => r.entity_id === '113')).toMatchObject({ spend: '40.00', financial_spend: '0', campaign_scope: 'external' });
    const ledger = (await db.pool.query(`SELECT count(*)::int n,sum(amount)::text amount FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='marketing.meta_spend.adjustment'`)).rows[0];
    expect(ledger).toMatchObject({ n: 1, amount: '50.00' });
    const allowed = (await db.pool.query(`SELECT marketing.meta_ad_scope_allowed('test','act_123','111') own,
      marketing.meta_ad_scope_allowed('test','act_123','113') foreign_ad,
      marketing.meta_ad_scope_allowed('test','act_123','999') unknown_ad,
      marketing.meta_ad_scope_allowed('prod','act_123','113') other_environment`)).rows[0];
    expect(allowed).toEqual({ own: true, foreign_ad: false, unknown_ad: false, other_environment: true });
  });
  it('falha na Meta preserva o snapshot e o valor financeiro', async () => {
    await expect(sync({ dbPool: db.pool, config, fetcher: async () => Response.json({ error: {} }, { status: 503 }) })).rejects.toThrow();
    expect((await db.pool.query(`SELECT count(*)::int n FROM marketing.meta_ad_identities WHERE environment='test'`)).rows[0].n).toBe(3);
    expect((await db.pool.query(`SELECT financial_spend::text FROM marketing.meta_insights_daily_scoped WHERE environment='test' AND entity_level='campaign'`)).rows[0].financial_spend).toBe('50.00');
  });
  it('corrige por diferença quando a Meta retorna zero, sem manter gasto antigo nem apagar o histórico', async () => {
    const empty = (async (url: URL | RequestInfo, init?: RequestInit) => String(url).includes('/ads?')
      ? fetcher(url, init) : Response.json({ data: [] })) as typeof fetch;
    await sync({ dbPool: db.pool, config, fetcher: empty, now: new Date('2026-09-30T12:00:00Z'), lookbackDays: 2 });
    expect((await db.pool.query(`SELECT financial_spend::text FROM marketing.meta_insights_daily_scoped
      WHERE environment='test' AND entity_level='campaign'`)).rows[0].financial_spend).toBe('0.00');
    expect((await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='marketing.meta_spend.adjustment'`)).rows[0].n).toBe(2);
    const net = (await db.pool.query(`SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)::text net
      FROM finance.matriz_ledger_entries WHERE environment='test' AND account_code='marketing_expense'`)).rows[0].net;
    expect(Number(net)).toBe(0);
  });
});
