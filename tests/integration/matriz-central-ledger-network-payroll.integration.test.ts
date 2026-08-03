import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import {
  buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';

describe('Etapa 5 — Rede e colaboradores no livro central', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      MATRIZ_CENTRAL_LEDGER: 'true', NETWORK_COMMISSION_LEDGER: 'true',
      MATRIZ_CENTRAL_LEDGER_READ: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    process.env.PARTNER_DATABASE_URL =
      buildRestrictedConnectionString(db.connectionString);
    vi.resetModules();
  }, 180_000);

  afterAll(async () => {
    const { partnerPool } = await import('../../src/parceiro/db.js');
    await partnerPool.end();
    if (db) await stopPostgres(db);
    delete process.env.PARTNER_DATABASE_URL;
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
    process.env.MATRIZ_CENTRAL_LEDGER_READ = 'false';
    vi.resetModules();
  });

  it('comissão recebida e depois estornada preserva caixa até a devolução', async () => {
    const partner = await import('../../src/parceiro/queries.js');
    const admin = await import('../../src/admin/painel/queries.js');
    const fixture = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    await db.pool.query(
      `UPDATE network.partners
          SET commercial_model='commission',commission_percent=10 WHERE id=$1`,
      [fixture.partnerId],
    );
    const sale = await partner.registerPartnerSale(fixture.ctx, {
      customer_name: 'Cliente comissão central', customer_phone: null,
      items: [{ partner_stock_id: fixture.stockId, quantity: 1, unit_price: 200 }],
      payment_method: 'pix', fulfillment_mode: 'delivery',
      delivery_address: 'Rua Etapa 5, 10', source_tag: '2w',
      idempotency_key: randomUUID(),
    }, db.pool);
    await partner.updatePartnerDeliveryStatus(fixture.ctx, sale.order_id, {
      delivery_status: 'delivered', payment_method: 'pix', delivery_courier: 'Teste',
    }, db.pool);
    await admin.sweepCommissionEntries('test', db.pool);

    const entry = await db.pool.query<{ id: string }>(
      `SELECT id FROM network.commission_entries WHERE partner_order_id=$1`,
      [sale.order_id],
    );
    await admin.settleCommissionEntries({
      partner_id: fixture.partnerId, settled_by: 'owner:commission',
      idempotency_key: randomUUID(), reason: 'Comissão recebida',
      environment: 'test',
    }, db.pool);
    await partner.cancelPartnerSale(
      fixture.ctx, sale.order_id, 'Venda cancelada após recebimento', db.pool,
    );
    await admin.sweepCommissionEntries('test', db.pool);
    const reversal = await db.pool.query<{ id: string }>(
      `SELECT id FROM finance.matriz_commission_reversals
        WHERE commission_entry_id=$1`,
      [entry.rows[0]!.id],
    );

    const beforeRefund = await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='network.commission_entry.payment'
             AND source_id=$1) payments,
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='network.commission_entry.reversal'
             AND source_id=$2) reversals,
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='network.commission_refund.payment'
             AND source_id=$2) refunds`,
      [entry.rows[0]!.id, reversal.rows[0]!.id],
    );
    expect(beforeRefund.rows[0]).toEqual({ payments: 1, reversals: 1, refunds: 0 });

    await admin.settleCommissionRefund({
      reversal_id: reversal.rows[0]!.id, actor_label: 'owner:refund',
      idempotency_key: randomUUID(), reason: 'Devolução ao parceiro',
      environment: 'test',
    }, db.pool);
    const afterRefund = await db.pool.query(
      `SELECT jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries,
              (SELECT count(*)::int FROM finance.matriz_ledger_payments p
                WHERE p.payment_transaction_id=t.id) allocations
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test'
          AND t.source_type='network.commission_refund.payment'
          AND t.source_id=$1 GROUP BY t.id`,
      [reversal.rows[0]!.id],
    );
    expect(afterRefund.rows[0].entries).toEqual({
      commission_refund_payable: 'debit', cash: 'credit',
    });
    expect(afterRefund.rows[0].allocations).toBe(1);
  });

  it('fechamento da folha cria obrigação e pagamento baixa caixa uma vez', async () => {
    const payroll = await import('../../src/admin/painel/queries-colaboradores-folha.js');
    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment,username)
       VALUES ('test','folha.central') RETURNING id`,
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area)
       VALUES ('test',$1,'Colaborador Central','colaborador','Auxiliar','other')
       RETURNING id`,
      [person.rows[0]!.id],
    );
    await payroll.saveMatrizCollaboratorCompensation({
      collaborator_id: collaborator.rows[0]!.id, employment_type: 'clt',
      base_salary: 2100, payment_day: 5, payment_method: 'pix',
      starts_on: '2026-07-01', environment: 'test',
    }, db.pool);
    const closed = await payroll.closeMatrizPayroll({
      competence: '2026-09-01', environment: 'test', actor_label: 'owner:payroll',
    }, db.pool);
    const item = await db.pool.query<{ id: string; source_expense_id: string }>(
      `SELECT id,source_expense_id FROM finance.matriz_payroll_items
        WHERE payroll_period_id=$1`,
      [closed.period_id],
    );
    const accrual = await db.pool.query<{ transaction_kind: string }>(
      `SELECT transaction_kind FROM finance.matriz_ledger_transactions
        WHERE environment='test'
          AND source_type='commerce.matriz_expense.accrual'
          AND source_id=$1`,
      [item.rows[0]!.source_expense_id],
    );
    expect(accrual.rows[0]!.transaction_kind).toBe('expense_payable');

    const paymentInput = {
      item_id: item.rows[0]!.id, environment: 'test' as const,
      actor_label: 'owner:payroll', idempotency_key: randomUUID(),
    };
    const paid = await payroll.payMatrizPayrollItem(paymentInput, db.pool);
    expect(await payroll.payMatrizPayrollItem(paymentInput, db.pool)).toEqual(paid);
    const proof = await db.pool.query(
      `SELECT count(*)::int payments
         FROM finance.matriz_ledger_transactions
        WHERE environment='test'
          AND source_type='commerce.matriz_expense.payment'
          AND source_id=$1`,
      [item.rows[0]!.source_expense_id],
    );
    expect(proof.rows[0].payments).toBe(1);
  });

  it('mensalidade deixa de ser configuração e vira recebível por competência', async () => {
    const admin = await import('../../src/admin/painel/queries.js');
    const fixture = await createPartnerFixture(db.pool);
    await db.pool.query(
      `UPDATE network.partners
          SET commercial_model='monthly',monthly_fee=150 WHERE id=$1`,
      [fixture.partnerId],
    );
    const currentCompetence = await db.pool.query<{ competence: string }>(
      `SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date::text
              AS competence`,
    );
    await admin.sweepCommissionEntries('test', db.pool);
    const fees = await admin.listMatrizPartnerMonthlyFees('test', db.pool);
    const fee = fees.find((row) => row.partner_id === fixture.partnerId);
    expect(fee).toMatchObject({
      competence: currentCompetence.rows[0]!.competence,
      amount: '150.00', status: 'open',
    });
    const accrual = await db.pool.query(
      `SELECT t.amount::text,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test' AND t.source_type='network.monthly_fee.accrual'
          AND t.source_id=$1 GROUP BY t.id`,
      [fee!.id],
    );
    expect(accrual.rows[0]).toEqual({
      amount: '150.00',
      entries: {
        network_monthly_fee_receivable: 'debit',
        network_monthly_fee_revenue: 'credit',
      },
    });

    const input = {
      fee_id: fee!.id, actor_label: 'owner:monthly',
      idempotency_key: randomUUID(), environment: 'test' as const,
    };
    const settled = await admin.settleMatrizPartnerMonthlyFee(input, db.pool);
    expect(await admin.settleMatrizPartnerMonthlyFee(input, db.pool)).toEqual(settled);
    const payment = await db.pool.query(
      `SELECT count(*)::int payments FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_type='network.monthly_fee.payment'
          AND source_id=$1`,
      [fee!.id],
    );
    expect(payment.rows[0].payments).toBe(1);

    const reconciliation = await import(
      '../../src/admin/painel/matriz-ledger-stage5-reconciliation.js'
    );
    const report = await reconciliation.runMatrizStage5LedgerBackfill(
      { environment: 'test' }, db.pool,
    );
    expect(report.reconciliation).toMatchObject({
      enabled: true, status: 'green', total_errors: 0,
    });
    const healthModule = await import(
      '../../src/admin/painel/matriz-ledger-integration-health.js'
    );
    const health = await healthModule.getMatrizLedgerIntegrationHealth(
      'test', db.pool,
    );
    expect(health).toMatchObject({
      enabled: true,
      status: 'green',
      modules: {
        financeiro: { status: 'green', score: 10 },
        estoque: { status: 'green', score: 10 },
        logistica: { status: 'green', score: 10 },
        marketing: { status: 'green', score: 10 },
        rede: { status: 'green', score: 10 },
        colaboradores: { status: 'green', score: 10 },
      },
      global: { total_error_signals: 0 },
    });
    const centralRead = await import(
      '../../src/admin/painel/matriz-ledger-financial-read.js'
    );
    const truth = await centralRead.getMatrizCentralLedgerFinancialTruth(
      'test', db.pool,
    );
    expect(truth).toMatchObject({
      competencia: {
        receita_total: '150.00', lucro_confirmado: '150.00',
        status: 'confirmado',
      },
      caixa: {
        entradas_registradas: '170.00', saidas_registradas: '2120.00',
        movimento_liquido: '-1950.00',
        recebimentos: { mensalidades: '150.00' },
      },
      posicao: { a_receber: '0.00', a_pagar: '0.00' },
      conciliacao: { status: 'ok', diferenca_total: '0.00' },
    });
    const readSwitch = await import(
      '../../src/admin/painel/queries-financeiro-read-switch.js'
    );
    const selected = await readSwitch.getMatrizFinancialRead('test', db.pool);
    expect(selected).toMatchObject({
      source: 'central_ledger', integration_status: 'green',
      truth: { competencia: { receita_total: '150.00' } },
    });
    expect(selected).not.toHaveProperty('comparison');
    expect(selected).not.toHaveProperty('fallback_reason');
  });
});
