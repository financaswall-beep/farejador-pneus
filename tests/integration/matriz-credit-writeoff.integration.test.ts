import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('ciclo contabil do credito da Matriz', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
      MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  it('recebe parcialmente e reconhece a perda restante sem inflar o caixa', async () => {
    const sourceId = `credit-${randomUUID()}`;
    const obligation = await db.pool.query<{ id: string }>(
      `SELECT finance.post_matriz_ledger_transaction(
         'test','commerce.order.revenue',$1,'sale_credit',150,current_date,
         'Venda fiada de teste','owner:integration',$2::jsonb,current_date,NULL,'{}'::jsonb
       ) id`,
      [sourceId, JSON.stringify([
        { account_code: 'accounts_receivable', account_class: 'asset', side: 'debit', amount: 150 },
        { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount: 150 },
      ])],
    );
    const obligationId = obligation.rows[0]!.id;
    const { settleMatrizLedgerOpenItem } = await import(
      '../../src/admin/painel/matriz-ledger-settlement.js'
    );
    const { writeOffMatrizCredit } = await import(
      '../../src/admin/painel/matriz-ledger-writeoff.js'
    );

    const receiptKey = `receipt-${randomUUID()}`;
    const receipt = await settleMatrizLedgerOpenItem({
      environment: 'test', obligation_id: obligationId, amount: 50,
      payment_method: 'Pix', actor_label: 'owner:integration',
      idempotency_key: receiptKey,
    }, db.pool);
    expect(receipt).toMatchObject({ amount: '50.00', remaining_balance: '100.00' });
    const repeatedReceipt = await settleMatrizLedgerOpenItem({
      environment: 'test', obligation_id: obligationId, amount: 50,
      payment_method: 'Pix', actor_label: 'owner:integration',
      idempotency_key: receiptKey,
    }, db.pool);
    expect(repeatedReceipt.payment_ids).toEqual(receipt.payment_ids);

    const lossKey = `loss-${randomUUID()}`;
    const loss = await writeOffMatrizCredit({
      environment: 'test', obligation_id: obligationId, amount: 100,
      reason: 'Credito sem expectativa de recebimento', actor_label: 'owner:integration',
      idempotency_key: lossKey,
    }, db.pool);
    expect(loss).toMatchObject({ amount: '100.00', remaining_balance: '0.00' });
    expect((await writeOffMatrizCredit({
      environment: 'test', obligation_id: obligationId, amount: 100,
      reason: 'Credito sem expectativa de recebimento', actor_label: 'owner:integration',
      idempotency_key: lossKey,
    }, db.pool)).writeoff_transaction_id).toBe(loss.writeoff_transaction_id);

    const proof = await db.pool.query<{
      balance: string; cash_debits: string; bad_debt_debits: string; allocations: number;
    }>(
      `SELECT
         finance.matriz_ledger_obligation_balance('test',$1)::text balance,
         COALESCE((SELECT sum(amount) FROM finance.matriz_ledger_entries
           WHERE environment='test' AND account_code='cash' AND side='debit'),0)::text cash_debits,
         COALESCE((SELECT sum(amount) FROM finance.matriz_ledger_entries
           WHERE environment='test' AND account_code='bad_debt_expense' AND side='debit'),0)::text bad_debt_debits,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments
           WHERE environment='test' AND obligation_transaction_id=$1) allocations`,
      [obligationId],
    );
    expect(proof.rows[0]).toEqual({
      balance: '0.00', cash_debits: '50.00', bad_debt_debits: '100.00', allocations: 2,
    });
  });
});
