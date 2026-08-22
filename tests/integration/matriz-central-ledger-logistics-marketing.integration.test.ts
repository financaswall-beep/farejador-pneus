import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 4 — logística e marketing no livro central', () => {
  let db: IntegrationDb;
  let createExpense: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).createMatrizExpense;
  let settleExpense: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).settleMatrizExpense;
  let removeExpense: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).removeMatrizExpense;
  let approveReceipt: typeof import(
    '../../src/admin/painel/queries-logistica-comprovantes-decision.js'
  ).approveMatrizTripReceipt;
  let syncMeta: typeof import('../../src/marketing/meta-sync.js').syncMetaInsights;
  let getOpenItems: typeof import(
    '../../src/admin/painel/matriz-ledger-open-items.js'
  ).getMatrizLedgerOpenItems;
  let settleOpenItem: typeof import(
    '../../src/admin/painel/matriz-ledger-settlement.js'
  ).settleMatrizLedgerOpenItem;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT: '10000',
      MATRIZ_CENTRAL_LEDGER_READ: 'true',
      ADMIN_BEARER_FALLBACK_ENABLED: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({
      createMatrizExpense: createExpense,
      settleMatrizExpense: settleExpense,
      removeMatrizExpense: removeExpense,
    } = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ approveMatrizTripReceipt: approveReceipt } =
      await import('../../src/admin/painel/queries-logistica-comprovantes-decision.js'));
    ({ syncMetaInsights: syncMeta } = await import('../../src/marketing/meta-sync.js'));
    ({ getMatrizLedgerOpenItems: getOpenItems } =
      await import('../../src/admin/painel/matriz-ledger-open-items.js'));
    ({ settleMatrizLedgerOpenItem: settleOpenItem } =
      await import('../../src/admin/painel/matriz-ledger-settlement.js'));
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  it('despesa pendente nasce como obrigação e o pagamento zera o saldo', async () => {
    const expense = await createExpense({
      environment: 'test', category: 'frete', description: 'Frete de coleta',
      amount: 85, payment_status: 'pending', due_date: '2026-08-10',
      created_by: 'owner:expense', idempotency_key: randomUUID(),
    }, db.pool);
    await settleExpense(expense.id, 'test', db.pool, {
      actor_label: 'owner:payment', idempotency_key: randomUUID(),
    });

    const proof = await db.pool.query(
      `SELECT
         (SELECT transaction_kind FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='commerce.matriz_expense.accrual'
             AND source_id=$1) accrual_kind,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments p
           JOIN finance.matriz_ledger_transactions t
             ON t.id=p.obligation_transaction_id
          WHERE t.source_type='commerce.matriz_expense.accrual'
            AND t.source_id=$1) payments,
         (SELECT finance.matriz_ledger_obligation_balance('test',id)
            FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='commerce.matriz_expense.accrual'
             AND source_id=$1) balance`,
      [expense.id],
    );
    expect(proof.rows[0]).toMatchObject({
      accrual_kind: 'expense_payable', payments: 1,
    });
    expect(Number(proof.rows[0].balance)).toBe(0);
  });

  it('remoção de despesa já paga preserva caixa e cria valor a recuperar', async () => {
    const expense = await createExpense({
      environment: 'test', category: 'manutencao', description: 'Lançamento incorreto',
      amount: 120, payment_status: 'paid', created_by: 'owner:expense',
      idempotency_key: randomUUID(),
    }, db.pool);
    await removeExpense(expense.id, 'test', db.pool, {
      actor_label: 'owner:remove', reason: 'Fornecedor deve devolver o valor',
      idempotency_key: randomUUID(),
    });
    const proof = await db.pool.query(
      `SELECT t.transaction_kind,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test'
          AND t.source_type='commerce.matriz_expense.remove' AND t.source_id=$1
        GROUP BY t.id`,
      [expense.id],
    );
    expect(proof.rows[0]).toEqual({
      transaction_kind: 'expense_refund_receivable',
      entries: {
        expense_refund_receivable: 'debit',
        expense_manutencao: 'credit',
      },
    });
    const open = await getOpenItems('test', db.pool);
    const refund = open.a_receber.itens.find((item) =>
      item.tipo === 'devolucao_despesa' && item.id === expense.id);
    expect(refund).toMatchObject({ valor: '120.00', settlement_mode: 'central_obligation' });
    const key = randomUUID();
    const partial = await settleOpenItem({
      obligation_id: refund!.obligation_id!, amount: 50,
      idempotency_key: key, actor_label: 'owner:refund-receipt', environment: 'test',
    }, db.pool);
    expect(await settleOpenItem({
      obligation_id: refund!.obligation_id!, amount: 50,
      idempotency_key: key, actor_label: 'owner:refund-receipt', environment: 'test',
    }, db.pool)).toEqual(partial);
    expect((await getOpenItems('test', db.pool)).a_receber.itens.find(
      (item) => item.obligation_id === refund!.obligation_id,
    )?.valor).toBe('70.00');
  });

  it('comprovante aprovado cria uma despesa e um lançamento, sem duplicar', async () => {
    const trip = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
       VALUES ('test','Entregador livro central') RETURNING id`,
    );
    const receipt = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_trip_receipts
         (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
       VALUES ('test',$1,'image/jpeg',18,'skipped','review_required') RETURNING id`,
      [trip.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
       VALUES ($1,'test',convert_to('receipt-ledger-etapa4','UTF8'))`,
      [receipt.rows[0]!.id],
    );
    const input = {
      receipt_id: receipt.rows[0]!.id, amount: 64.5, category: 'combustivel',
      merchant: 'Posto Etapa 4', document_date: '2026-07-20',
      competence_month: '2026-07-01', payment_status: 'paid' as const,
      payment_date: '2026-07-20', idempotency_key: randomUUID(),
      actor_label: 'owner:receipt', environment: 'test' as const,
    };
    const approved = await approveReceipt(input, db.pool);
    expect(await approveReceipt(input, db.pool)).toEqual(approved);

    const proof = await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM commerce.matriz_expenses e
           WHERE e.id=$1) expenses,
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions t
           WHERE t.environment='test'
             AND t.source_type='commerce.matriz_expense.accrual'
             AND t.source_id=$1::text) ledger`,
      [approved.expense_id],
    );
    expect(proof.rows[0]).toEqual({ expenses: 1, ledger: 1 });
    await expect(removeExpense(approved.expense_id, 'test', db.pool, {
      actor_label: 'owner:remove', reason: 'Tentativa bloqueada',
      idempotency_key: randomUUID(),
    })).rejects.toThrow('receipt_expense_locked');
  });

  it('Meta contabiliza somente campanha e corrige recoleta por diferença', async () => {
    const fetcherFor = (spend: string) => (async (input: URL | RequestInfo) => {
      const level = new URL(String(input)).searchParams.get('level');
      return new Response(JSON.stringify({ data: [{
        campaign_id: 'camp-etapa4', campaign_name: 'Campanha Etapa 4',
        ...(level === 'ad' ? { ad_id: 'ad-etapa4', ad_name: 'Criativo' } : {}),
        date_start: '2026-07-25', spend, account_currency: 'BRL',
        impressions: '1000', clicks: '20', actions: [],
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const config = {
      adAccountId: 'act_etapa4', accessToken: 'server-only', apiVersion: 'v21.0',
    };
    await syncMeta({
      dbPool: db.pool, config, fetcher: fetcherFor('10.50'),
      now: new Date('2026-07-25T18:00:00Z'), lookbackDays: 1,
    });
    await syncMeta({
      dbPool: db.pool, config, fetcher: fetcherFor('12.00'),
      now: new Date('2026-07-25T19:00:00Z'), lookbackDays: 1,
    });

    const proof = await db.pool.query(
      `SELECT
         count(DISTINCT t.id)::int transactions,
         COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)
           FILTER (WHERE e.account_code='marketing_expense'),0)::text net_spend,
         count(*) FILTER (WHERE e.account_code='sales_revenue')::int revenue_lines
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND t.source_type='marketing.meta_spend.adjustment'`,
    );
    expect(proof.rows[0]).toEqual({
      transactions: 2, net_spend: '12.00', revenue_lines: 0,
    });
    const agenda = await getOpenItems('test', db.pool);
    const marketing = agenda.a_pagar.itens.find((item) => item.tipo === 'marketing');
    expect(marketing).toMatchObject({
      valor: '12.00', settlement_mode: 'central_account',
      account_code: 'marketing_payable',
    });
    await settleOpenItem({
      account_code: 'marketing_payable', amount: 5,
      idempotency_key: randomUUID(), actor_label: 'owner:marketing',
      environment: 'test',
    }, db.pool);
    expect((await getOpenItems('test', db.pool)).a_pagar.itens.find(
      (item) => item.tipo === 'marketing',
    )?.valor).toBe('7.00');
    const { getMatrizFinanceiroVisao } =
      await import('../../src/admin/painel/queries-financeiro-visao.js');
    const financeiro = await getMatrizFinanceiroVisao('test', db.pool);
    expect(financeiro.leitura.source).toBe('central_ledger');
    expect(financeiro.a_pagar.itens.find(
      (item) => item.tipo === 'marketing',
    )?.valor).toBe('7.00');
    expect(financeiro.a_pagar.total).toBe(financeiro.verdade.posicao.a_pagar);
    expect(financeiro.a_receber.total).toBe(financeiro.verdade.posicao.a_receber);
    await settleOpenItem({
      account_code: 'marketing_payable',
      idempotency_key: randomUUID(), actor_label: 'owner:marketing',
      environment: 'test',
    }, db.pool);
    expect((await getOpenItems('test', db.pool)).a_pagar.itens.find(
      (item) => item.tipo === 'marketing',
    )).toBeUndefined();
  });

  it('backfill legado é repetível e termina verde', async () => {
    await db.pool.query(
      `INSERT INTO commerce.matriz_expenses
         (environment,category,description,amount,payment_status,paid_at,created_by)
       VALUES ('test','outros','Despesa anterior ao ledger',31,'paid',now(),'legacy')`,
    );
    const run = await db.pool.query<{ id: string }>(
      `INSERT INTO marketing.meta_sync_runs
         (environment,trigger_type,window_since,window_until,status,finished_at)
       VALUES ('test','manual','2026-07-24','2026-07-24','succeeded',now()) RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO marketing.meta_insights_daily
         (environment,sync_run_id,ad_account_id,api_version,account_currency,
          entity_level,entity_id,campaign_id,metric_date,spend)
       VALUES ('test',$1,'act_legacy','v21.0','BRL','campaign',
               'camp-legacy','camp-legacy','2026-07-24',33)`,
      [run.rows[0]!.id],
    );

    const { runMatrizStage4LedgerBackfill } =
      await import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js');
    const first = await runMatrizStage4LedgerBackfill(
      { environment: 'test', limit: 100 }, db.pool,
    );
    expect(first.processed).toEqual({ expenses: 1, marketing: 1 });
    expect(first.reconciliation).toMatchObject({ status: 'green', total_errors: 0 });

    const second = await runMatrizStage4LedgerBackfill(
      { environment: 'test', limit: 100 }, db.pool,
    );
    expect(second.processed).toEqual({ expenses: 0, marketing: 0 });
    expect(second.reconciliation.total_errors).toBe(0);
  });

  it('rota owner baixa o saldo central e repete a mesma resposta no replay', async () => {
    const item = (await getOpenItems('test', db.pool)).a_receber.itens.find(
      (row) => row.tipo === 'devolucao_despesa' && row.valor === '70.00',
    );
    expect(item?.obligation_id).toBeTruthy();
    const { default: Fastify } = await import('fastify');
    const { registerPainelFinanceiroLedger } =
      await import('../../src/admin/painel/route-financeiro-ledger.js');
    const app = Fastify();
    await registerPainelFinanceiroLedger(app);
    const body = {
      obligation_id: item!.obligation_id, amount: 70,
      idempotency_key: randomUUID(),
    };
    const unauthorized = await app.inject({
      method: 'POST', url: '/admin/api/matriz/financeiro/ledger/settle', payload: body,
    });
    expect(unauthorized.statusCode).toBe(401);
    const request = {
      method: 'POST' as const,
      url: '/admin/api/matriz/financeiro/ledger/settle',
      headers: { authorization: 'Bearer emergency-token' }, payload: body,
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await getOpenItems('test', db.pool)).a_receber.itens.find(
      (row) => row.obligation_id === item!.obligation_id,
    )).toBeUndefined();
    await app.close();
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
  });
});
