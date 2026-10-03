import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('gasto Meta pendente por período, sem efeito financeiro automático', () => {
  let db: IntegrationDb;
  let sync: typeof import('../../src/marketing/meta-sync.js').syncMetaInsights;
  let decide: typeof import('../../src/marketing/meta-identity-decisions.js').setMetaIdentityDecision;
  let start: typeof import('../../src/marketing/meta-finance-start.js').setMetaFinanceStart;
  let seq = 900;
  const now = new Date('2026-10-02T12:00:00Z');
  const ownInstagram = '17841465774227389';
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin', MATRIZ_CENTRAL_LEDGER: 'true',
      MATRIZ_CENTRAL_LEDGER_READ: 'true', MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'true' });
    db = await startPostgres(); process.env.DATABASE_URL = db.connectionString; vi.resetModules();
    ({ syncMetaInsights: sync } = await import('../../src/marketing/meta-sync.js'));
    ({ setMetaIdentityDecision: decide } = await import('../../src/marketing/meta-identity-decisions.js'));
    ({ setMetaFinanceStart: start } = await import('../../src/marketing/meta-finance-start.js'));
  }, 240_000);
  afterAll(async () => {
    const { pool } = await import('../../src/persistence/db.js'); await pool.end();
    if (db) await stopPostgres(db);
  });

  async function account(since = '2026-06-01') {
    const id = String(++seq), config = { adAccountId: `act_${id}`, accessToken: 'test-only', apiVersion: 'v26.0' };
    const run = (await db.pool.query(`INSERT INTO marketing.meta_sync_runs
      (environment,trigger_type,window_since,window_until,status,finished_at) VALUES('test','manual',$1,$1,'succeeded',now()) RETURNING id`, [since])).rows[0];
    await db.pool.query(`INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id,finance_since)
      VALUES('test',$1,$2,$3)`, [config.adAccountId, run.id, since]);
    const state = { status: 'PAUSED', foreignPage: '999', fail: false, omit: false,
      spend: [] as { date: string; amount: string }[], urls: [] as URL[] };
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input)); state.urls.push(url);
      if (url.pathname.endsWith('/ads')) return Response.json({ data: state.omit ? [] : [
        { id, campaign_id: id, effective_status: state.status,
          creative: { actor_id: state.foreignPage, instagram_user_id: ownInstagram } },
        { id: id + '1', campaign_id: id, effective_status: 'ACTIVE', creative: { actor_id: '777' } },
      ] });
      if (state.fail) return Response.json({ error: {} }, { status: 503 });
      expect(JSON.parse(url.searchParams.get('filtering')!)[0].value).toEqual([id]);
      const range = JSON.parse(url.searchParams.get('time_range')!);
      return Response.json({ data: state.spend.filter(row => row.date >= range.since && row.date <= range.until)
        .map(row => ({ ad_id: id, campaign_id: id, date_start: row.date, spend: row.amount,
          account_currency: 'BRL', impressions: '10', clicks: '1', actions: [] })) });
    }) as typeof fetch;
    const collect = () => sync({ dbPool: db.pool, config, fetcher, now, lookbackDays: 7 });
    const pending = async (since: string, until: string) => (await db.pool.query(`SELECT *
      FROM marketing.meta_pending_campaigns('test',$1,$2) WHERE ad_account_id=$3`, [since, until, config.adAccountId])).rows;
    const classify = (scope: 'matrix' | 'external' | 'automatic') => decide({ account: config.adAccountId, ad: id,
      scope, reason: 'Conferência específica deste anúncio', actor: 'owner:test', idempotencyKey: `${id}-${scope}-${Date.now()}` }, db.pool);
    return { id, config, state, collect, pending, classify };
  }

  it('nunca ativo e sem gasto: prova o histórico uma vez e não cobra revisão financeira', async () => {
    const a = await account(); a.state.status = 'PENDING_REVIEW'; await a.collect();
    expect(await a.pending('2026-06-01', '2026-10-02')).toEqual([]);
    expect(a.state.urls.filter(url => url.pathname.endsWith('/insights'))[0].searchParams.get('fields'))
      .toBe('ad_id,campaign_id,date_start,spend,account_currency');
    expect(JSON.parse(a.state.urls.find(url => url.pathname.endsWith('/insights'))!.searchParams.get('time_range')!).since).toBe('2026-06-01');
    a.state.urls = []; await a.collect();
    expect(JSON.parse(a.state.urls.find(url => url.pathname.endsWith('/insights'))!.searchParams.get('time_range')!).since).toBe('2026-09-26');
    const { listMetaIdentityReviews } = await import('../../src/marketing/meta-identity-decisions.js');
    expect((await listMetaIdentityReviews(db.pool)).rows.some(row => row.ad_id === a.id)).toBe(true);
    expect((await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='marketing.meta_spend.adjustment'`)).rows[0].n).toBe(0);
  });

  it('pausado há mais de 61 dias: gasto de julho só deixa julho amarelo, sem lançar despesa', async () => {
    const a = await account(); a.state.spend = [{ date: '2026-07-15', amount: '12.50' }]; await a.collect();
    expect(await a.pending('2026-07-01', '2026-07-31')).toEqual([expect.objectContaining({ reason: 'unclassified_spend' })]);
    expect(await a.pending('2026-10-01', '2026-10-02')).toEqual([]);
    const { getMatrizLedgerCompetenceGate } = await import('../../src/admin/painel/matriz-ledger-competence-gate.js');
    // A competência sem gasto precisa estar inteiramente coberta pela coleta simulada.
    // Outubro é o mês da coleta (02/10); consultá-lo inteiro passa a exigir o dia 03
    // quando o relógio real do PostgreSQL avança, mesmo com a coleta do teste congelada.
    const gate = await getMatrizLedgerCompetenceGate(['2026-07-01', '2026-09-01'], 'test', db.pool);
    expect(gate.competences[0].status).toBe('yellow'); expect(gate.competences[1].status).toBe('green');
    expect(gate.total_abs_difference).toBe('0.00');
    const { getMatrizFinancialRead } = await import('../../src/admin/painel/queries-financeiro-read-switch.js');
    expect((await getMatrizFinancialRead('test', db.pool, '2026-07')).integration_status).toBe('yellow');
    expect((await getMatrizFinancialRead('test', db.pool, '2026-09')).integration_status).toBe('green');
    expect((await db.pool.query(`SELECT count(*)::int n FROM marketing.meta_insights_daily WHERE ad_account_id=$1`, [a.config.adAccountId])).rows[0].n).toBe(0);
    await a.classify('external');
  });

  it('anúncio que volta a gastar volta à revisão; ativo sem gasto só alerta no Marketing', async () => {
    const a = await account(); await a.collect(); a.state.status = 'ACTIVE'; await a.collect();
    expect(await a.pending('2026-10-01', '2026-10-02')).toEqual([]);
    const { getMarketingAttributionHealth } = await import('../../src/admin/painel/queries-marketing-health.js');
    expect((await getMarketingAttributionHealth('test', '2026-10-01', '2026-10-02', db.pool)).pending_identity_campaigns).toBeGreaterThan(0);
    a.state.spend = [{ date: '2026-10-01', amount: '8.00' }]; await a.collect();
    expect((await a.pending('2026-10-01', '2026-10-02'))[0].reason).toBe('unclassified_spend');
    await a.classify('external');
  });

  it('falha não vira zero; sucesso seguinte resolve; mudança de identidade exige nova prova', async () => {
    const a = await account(); await a.collect(); a.state.fail = true; await a.collect();
    expect((await a.pending('2026-10-01', '2026-10-02'))[0].reason).toBe('verification_missing');
    a.state.fail = false; await a.collect(); expect(await a.pending('2026-10-01', '2026-10-02')).toEqual([]);
    a.state.foreignPage = '998'; a.state.fail = true; await a.collect();
    expect((await a.pending('2026-07-01', '2026-07-31'))[0].reason).toBe('verification_missing');
    a.state.fail = false; await a.collect(); expect(await a.pending('2026-07-01', '2026-07-31')).toEqual([]);
    a.state.omit = true; await a.collect();
    expect((await a.pending('2026-10-01', '2026-10-02'))[0].reason).toBe('verification_missing');
    a.state.omit = false; await a.collect(); await a.classify('external');
  });

  it('aprovação recolhe gasto antigo fora dos 7 dias, lança uma vez e preserva auditoria', async () => {
    const a = await account(); a.state.spend = [{ date: '2026-07-20', amount: '7.50' }]; await a.collect();
    await a.classify('matrix');
    a.state.fail = true;
    await expect(a.collect()).rejects.toThrow();
    expect((await a.pending('2026-07-01', '2026-07-31'))[0].reason).toBe('verification_missing');
    expect((await db.pool.query(`SELECT metrics_backfill_pending FROM marketing.meta_ad_identities
      WHERE environment='test' AND ad_account_id=$1 AND ad_id=$2`, [a.config.adAccountId, a.id]))
      .rows[0].metrics_backfill_pending).toBe(true);
    a.state.fail = false;
    await a.collect(); await a.collect();
    expect(await a.pending('2026-07-01', '2026-07-31')).toEqual([]);
    const entries = (await db.pool.query(`SELECT count(*)::int n,sum(t.amount)::text total
      FROM finance.matriz_ledger_transactions t JOIN marketing.meta_insights_daily i
        ON i.id::text=t.metadata->>'insight_id' AND i.environment=t.environment
      WHERE t.environment='test' AND i.ad_account_id=$1 AND t.source_type='marketing.meta_spend.adjustment'`, [a.config.adAccountId])).rows[0];
    expect(entries).toMatchObject({ n: 1, total: '7.50' });
    await expect(start({ account: a.config.adAccountId, since: '2026-10-01', reason: 'Tentativa de esconder histórico',
      actor: 'owner:test', idempotencyKey: 'cannot-hide' }, db.pool)).rejects.toThrow('meta_finance_start_has_history');
    await expect(db.pool.query(`UPDATE marketing.meta_pending_spend_checks SET status='failed' WHERE ad_id=$1`, [a.id]))
      .rejects.toThrow(/immutable/);
    expect((await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','marketing.meta_pending_spend_daily','SELECT') allowed`)).rows[0].allowed).toBe(false);
  });

  it('início explícito exclui gasto anterior da conferência e é auditado, sem apagar nada', async () => {
    const a = await account(); await a.collect();
    await start({ account: a.config.adAccountId, since: '2026-10-01', reason: 'Início oficial da operação de teste',
      actor: 'owner:test', idempotencyKey: 'official-start' }, db.pool);
    a.state.spend = [{ date: '2026-07-15', amount: '500.00' }]; await a.collect();
    expect(await a.pending('2026-07-01', '2026-07-31')).toEqual([]);
    expect(await a.pending('2026-10-01', '2026-10-02')).toEqual([]);
    expect((await db.pool.query(`SELECT count(*)::int n FROM audit.events WHERE event_type='marketing_meta_finance_start_changed'`)).rows[0].n).toBe(1);
    expect((await db.pool.query(`SELECT count(*)::int n FROM marketing.meta_pending_campaigns('prod','2026-06-01','2026-10-02')`)).rows[0].n).toBe(0);
  });

  it('falha histórica não bloqueia para sempre um novo início com coleta recente concluída', async () => {
    const a = await account(); a.state.fail = true; await a.collect();
    await start({ account: a.config.adAccountId, since: '2026-10-01', reason: 'Operação oficial começa nesta data',
      actor: 'owner:test', idempotencyKey: 'start-after-failure' }, db.pool);
    a.state.fail = false; await a.collect();
    expect(await a.pending('2026-10-01', '2026-10-02')).toEqual([]);
    expect(await a.pending('2026-07-01', '2026-07-31')).toEqual([]);
  });
});
