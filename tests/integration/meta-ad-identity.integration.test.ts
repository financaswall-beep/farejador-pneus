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
  it('alerta sobre identidade pendente sem métricas e aprova só o anúncio escolhido, com auditoria', async () => {
    const account = { ...config, adAccountId: 'act_789' };
    let foreignPage = '999', omit = false, insightRequests = 0;
    const mixedFetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/ads')) return Response.json({ data: omit ? [] : [
        { id: '881', campaign_id: '88', creative: { actor_id: foreignPage, instagram_user_id: '17841465774227389' } },
        { id: '882', campaign_id: '88', creative: { actor_id: '999' } },
      ] });
      insightRequests++;
      const ids = JSON.parse(url.searchParams.get('filtering') || '[]')[0]?.value || [];
      return Response.json({ data: ids.map((id: string) => ({ ad_id: id, campaign_id: '88', campaign_name: 'Mista',
        date_start: '2026-09-29', account_currency: 'BRL', spend: '30', impressions: '100', clicks: '10', actions: [] })) });
    }) as typeof fetch;
    const options = { dbPool: db.pool, config: account, fetcher: mixedFetcher, now: new Date('2026-09-30T12:00:00Z'), lookbackDays: 2 };
    await sync(options); expect(insightRequests).toBe(0);
    const {listMetaIdentityReviews:list,setMetaIdentityDecision:decide} = await import('../../src/marketing/meta-identity-decisions.js');
    const {getMatrizStage4LedgerReconciliation:stage4} = await import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js');
    const {getMarketingOverview:overview} = await import('../../src/admin/painel/queries-marketing.js');
    expect((await list(db.pool)).rows.find(row => row.ad_id === '881')).toMatchObject({ scope: 'pending', can_decide: true });
    expect((await stage4('test', db.pool)).pending_operational.marketing_campaigns_unclassified).toBe(1);
    const screen = await overview('30d', { dbPool: db.pool, config: { metaEnabled: false, attributionEnabled: true } });
    expect(screen.alerts.some(alert => alert.id === 'campaign-scope-pending')).toBe(true);
    await db.pool.query(`INSERT INTO marketing.meta_insights_daily
      (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,
        spend,impressions,clicks,conversations,actions_raw)
      SELECT v.environment::public.env_t,'act_789','v26.0','BRL','ad',v.ad,v.campaign,v.day::date,1,1,1,0,'[]'
      FROM (VALUES ('test','881','88','2026-09-29'),('test','883','90','2026-09-29'),
        ('test','884','90','2026-09-28'),('test','885','91','2026-08-01'),
        ('prod','886','92','2026-09-29')) v(environment,ad,campaign,day)`);
    const unionScreen = await overview('30d', { dbPool: db.pool, now: new Date('2026-09-30T12:00:00Z'),
      config: { metaEnabled: false, attributionEnabled: true } });
    expect(unionScreen.attribution.pending_identity_campaigns).toBe(2);
    expect(unionScreen.alerts.find(alert => alert.id === 'campaign-scope-pending')?.title)
      .toBe('2 campanha(s) com identidade pendente');
    await db.pool.query(`DELETE FROM marketing.meta_insights_daily WHERE ad_account_id='act_789'`);
    await decide({ account: account.adAccountId, ad: '881', scope: 'matrix', reason: 'Anúncio próprio verificado na Meta', actor: 'test', idempotencyKey: 'meta-decision-test' }, db.pool);
    await sync(options); expect(insightRequests).toBe(1);
    const scopes = (await db.pool.query(`SELECT ad_id,scope FROM marketing.meta_ad_identities WHERE environment='test' AND ad_account_id='act_789' ORDER BY ad_id`)).rows;
    expect(scopes).toEqual([{ad_id:'881',scope:'matrix'},{ad_id:'882',scope:'external'}]);
    const expense = async () => Number((await db.pool.query(`SELECT COALESCE(sum(CASE side WHEN 'debit' THEN amount ELSE -amount END),0) n
      FROM finance.matriz_ledger_entries WHERE environment='test' AND account_code='marketing_expense'`)).rows[0].n);
    expect(await expense()).toBe(30);
    await expect(db.pool.query(`UPDATE marketing.meta_ad_identity_decisions SET reason='Alteração proibida' WHERE ad_id='881'`)).rejects.toThrow(/immutable/i);
    expect((await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','marketing.meta_ad_identity_decisions','SELECT') allowed`)).rows[0].allowed).toBe(false);
    await decide({ account: account.adAccountId, ad: '881', scope: 'automatic', reason: 'Retornar à regra automática', actor: 'test', idempotencyKey: 'meta-return-automatic' },db.pool);
    await sync(options); expect(await expense()).toBe(0);
    await decide({ account: account.adAccountId, ad: '881', scope: 'matrix', reason: 'Nova confirmação deste anúncio', actor: 'test', idempotencyKey: 'meta-new-confirmation' },db.pool);
    await sync(options); expect(await expense()).toBe(30);
    foreignPage = '998'; await sync(options); expect(await expense()).toBe(0);
    expect((await list(db.pool)).rows.find(row=>row.ad_id==='881')?.scope).toBe('pending');
    omit = true; await sync(options);
    expect((await list(db.pool)).rows.find(row=>row.ad_id==='881')?.can_decide).toBe(false);
    await expect(decide({ account: account.adAccountId, ad: '881', scope: 'matrix', reason: 'Não aceitar snapshot antigo', actor: 'test', idempotencyKey: 'meta-old-snapshot' },db.pool))
      .rejects.toThrow('meta_identity_sync_required');
    expect((await db.pool.query(`SELECT count(*)::int n FROM audit.events WHERE event_type='marketing_meta_ad_identity_decided'`)).rows[0].n).toBe(3);
  });
});
