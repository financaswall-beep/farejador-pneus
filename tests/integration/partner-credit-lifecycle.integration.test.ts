import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

describe('ciclo contabil do credito do parceiro', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    db = await startPostgres();
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
    });
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('marca materialmente o schema consolidado na migration mais recente', async () => {
    const state = await db.pool.query(
      `SELECT version,migration_name FROM ops.application_schema_state WHERE singleton=true`,
    );
    expect(state.rows[0]).toEqual({
      version: 215,
      migration_name: '0215_partial_payment_reconciliation_health.sql',
    });
  });

  it('nao joga fiado no caixa e reconcilia parcial, perda e recuperacao', async () => {
    const q = await import('../../src/parceiro/queries.js');
    const fixture = await createPartnerFixture(db.pool, {
      initialStockQty: 5, role: 'owner', slugSuffix: `credit-${randomUUID().slice(0, 6)}`,
    });
    const sale = await q.registerPartnerSale(fixture.ctx, {
      customer_name: 'Cliente Fiado', customer_phone: null,
      items: [{ partner_stock_id: fixture.stockId, quantity: 1, unit_price: 150 }],
      payment_method: 'fiado', payment_status: 'receivable',
      receivable_due_date: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()),
      fulfillment_mode: 'pickup', source_tag: 'porta',
      idempotency_key: `sale-${randomUUID()}`,
    });
    const receivable = await db.pool.query<{ id: string }>(
      `SELECT id FROM finance.partner_receivables
        WHERE environment='test' AND source_order_id=$1`, [sale.order_id],
    );
    const receivableId = receivable.rows[0]!.id;

    let summary = await db.pool.query<{
      sales_month: string; estimated_result_month: string; cash_in_month: string;
      open_receivables_total: string; credit_writeoff_month: string;
    }>(`SELECT sales_month::text,estimated_result_month::text,cash_in_month::text,
               open_receivables_total::text,credit_writeoff_month::text
          FROM network.partner_unit_summary
         WHERE environment='test' AND unit_id=$1`, [fixture.unitId]);
    expect(summary.rows[0]).toMatchObject({
      sales_month: '150.00', estimated_result_month: '70.00',
      cash_in_month: '0', open_receivables_total: '150.00', credit_writeoff_month: '0',
    });

    const receiptKey = `receipt-${randomUUID()}`;
    await q.settlePartnerReceivable(fixture.ctx, receivableId, {
      amount: 50, payment_method: 'Pix', idempotency_key: receiptKey,
    });
    expect((await q.settlePartnerReceivable(fixture.ctx, receivableId, {
      amount: 50, payment_method: 'Pix', idempotency_key: receiptKey,
    })).received).toBe(true);
    await expect(q.settlePartnerReceivable(fixture.ctx, receivableId, {
      amount: 40, payment_method: 'Pix', idempotency_key: receiptKey,
    })).rejects.toThrow('partner_finance_idempotency_conflict');
    let effective = await db.pool.query<{
      status: string; received_amount: string; written_off_amount: string; open_amount: string;
    }>(`SELECT status,received_amount::text,written_off_amount::text,open_amount::text
          FROM finance.partner_receivables_effective
         WHERE environment='test' AND receivable_id=$1`, [receivableId]);
    expect(effective.rows[0]).toMatchObject({
      status: 'open', received_amount: '50.00', written_off_amount: '0.00', open_amount: '100.00',
    });

    summary = await db.pool.query(
      `SELECT sales_month::text,estimated_result_month::text,cash_in_month::text,
              open_receivables_total::text,credit_writeoff_month::text
         FROM network.partner_unit_summary
        WHERE environment='test' AND unit_id=$1`, [fixture.unitId],
    );
    expect(summary.rows[0]).toMatchObject({
      estimated_result_month: '70.00', cash_in_month: '50.00',
      open_receivables_total: '100.00', credit_writeoff_month: '0',
    });

    const lossKey = `loss-${randomUUID()}`;
    await q.writeOffPartnerReceivable(fixture.ctx, receivableId, {
      amount: 100, reason: 'Cliente nao pagou', idempotency_key: lossKey,
    });
    expect((await q.writeOffPartnerReceivable(fixture.ctx, receivableId, {
      amount: 100, reason: 'Cliente nao pagou', idempotency_key: lossKey,
    })).written_off).toBe(true);
    effective = await db.pool.query(
      `SELECT status,received_amount::text,written_off_amount::text,open_amount::text
         FROM finance.partner_receivables_effective
        WHERE environment='test' AND receivable_id=$1`, [receivableId],
    );
    expect(effective.rows[0]).toMatchObject({
      status: 'resolved', received_amount: '50.00',
      written_off_amount: '100.00', open_amount: '0.00',
    });
    summary = await db.pool.query(
      `SELECT estimated_result_month::text,cash_in_month::text,
              open_receivables_total::text,credit_writeoff_month::text
         FROM network.partner_unit_summary
        WHERE environment='test' AND unit_id=$1`, [fixture.unitId],
    );
    expect(summary.rows[0]).toMatchObject({
      estimated_result_month: '-30.00', cash_in_month: '50.00',
      open_receivables_total: '0', credit_writeoff_month: '100.00',
    });

    await q.recoverPartnerReceivable(fixture.ctx, receivableId, {
      amount: 20, payment_method: 'Pix', note: 'Recebimento tardio',
      idempotency_key: `recovery-${randomUUID()}`,
    });
    summary = await db.pool.query(
      `SELECT estimated_result_month::text,cash_in_month::text,
              open_receivables_total::text,credit_recovery_month::text
         FROM network.partner_unit_summary
        WHERE environment='test' AND unit_id=$1`, [fixture.unitId],
    );
    expect(summary.rows[0]).toMatchObject({
      estimated_result_month: '-10.00', cash_in_month: '70.00',
      open_receivables_total: '0', credit_recovery_month: '20.00',
    });
  });

  it('mantem a despesa por competencia e leva ao caixa somente cada pagamento', async () => {
    const q = await import('../../src/parceiro/queries.js');
    const fixture = await createPartnerFixture(db.pool, {
      role: 'owner', slugSuffix: `payable-${randomUUID().slice(0, 6)}`,
    });
    const dueDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const payable = await q.registerPartnerPayable(fixture.ctx, {
      counterparty_name: 'Locador', description: 'Aluguel do mes', category: 'rent',
      amount: 90, due_date: dueDate, status: 'open', payment_method: 'Pix',
      idempotency_key: `payable-${randomUUID()}`,
    });

    const readSummary = () => db.pool.query<{
      expenses_month: string; cash_out_month: string; open_payables_total: string;
    }>(`SELECT expenses_month::text,cash_out_month::text,open_payables_total::text
          FROM network.partner_unit_summary
         WHERE environment='test' AND unit_id=$1`, [fixture.unitId]);
    expect((await readSummary()).rows[0]).toEqual({
      expenses_month: '90.00', cash_out_month: '0', open_payables_total: '90.00',
    });

    const partialKey = `pay-partial-${randomUUID()}`;
    const partial = await q.settlePartnerPayable(fixture.ctx, payable.payable_id, {
      amount: 30, paid_at: new Date().toISOString(), payment_method: 'Pix',
      idempotency_key: partialKey,
    });
    expect(partial).toMatchObject({ paid: true, closed: false,
      amount: '30.00', remaining_balance: '60.00' });
    expect((await q.settlePartnerPayable(fixture.ctx, payable.payable_id, {
      amount: 30, paid_at: new Date().toISOString(), payment_method: 'Pix',
      idempotency_key: partialKey,
    })).remaining_balance).toBe('60.00');
    expect((await readSummary()).rows[0]).toEqual({
      expenses_month: '90.00', cash_out_month: '30.00', open_payables_total: '60.00',
    });

    const final = await q.settlePartnerPayable(fixture.ctx, payable.payable_id, {
      amount: 60, paid_at: new Date().toISOString(), payment_method: 'Pix',
      idempotency_key: `pay-final-${randomUUID()}`,
    });
    expect(final).toMatchObject({ paid: true, closed: true,
      amount: '60.00', remaining_balance: '0.00' });
    expect((await readSummary()).rows[0]).toEqual({
      expenses_month: '90.00', cash_out_month: '90.00', open_payables_total: '0',
    });
    const proof = await db.pool.query(
      `SELECT p.status,count(e.id)::int expense_rows,max(e.amount)::text expense_amount
         FROM finance.partner_payables p
         LEFT JOIN finance.partner_expenses e
           ON e.environment=p.environment AND e.source_payable_id=p.id
        WHERE p.environment='test' AND p.id=$1 GROUP BY p.id,p.status`,
      [payable.payable_id],
    );
    expect(proof.rows[0]).toEqual({
      status: 'paid', expense_rows: 1, expense_amount: '90.00',
    });
  });
});
