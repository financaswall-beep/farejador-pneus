import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('cancelamento de despesa por erro sem devolução fictícia', () => {
  let db: IntegrationDb;
  let cancel: typeof import('../../src/admin/painel/expense-cancellation.js').cancelExpenseByError;
  let expenses: typeof import('../../src/admin/painel/queries-financeiro-despesas-integridade.js');
  let remove: typeof import('../../src/admin/painel/queries-financeiro-despesas-remove.js').removeMatrizExpense;
  let open: typeof import('../../src/admin/painel/matriz-ledger-open-items.js').getMatrizLedgerOpenItems;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test', CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'test-emergency-token',
      MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT: '10000', WHOLESALE_FINANCE: 'true',
      MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    vi.resetModules(); db = await startPostgres(); process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ cancelExpenseByError: cancel } = await import('../../src/admin/painel/expense-cancellation.js'));
    expenses = await import('../../src/admin/painel/queries-financeiro-despesas-integridade.js');
    ({ removeMatrizExpense: remove } = await import('../../src/admin/painel/queries-financeiro-despesas-remove.js'));
    ({ getMatrizLedgerOpenItems: open } = await import('../../src/admin/painel/matriz-ledger-open-items.js'));
  }, 180_000);
  afterAll(async () => { if (db) await stopPostgres(db); vi.resetModules(); });
  const input = (id: string) => ({ id, reason: 'Duplicidade com compra por lote', idempotency_key: randomUUID() });
  async function create(paid = true, date?: string) {
    return expenses.createMatrizExpense({ environment: 'test', category: 'outros', amount: 3900,
      payment_status: paid ? 'paid' : 'pending', created_by: 'owner:test',
      occurred_at: date, paid_at: paid ? date : undefined,
      idempotency_key: randomUUID() }, db.pool);
  }
  async function net(id: string) {
    return (await db.pool.query(`SELECT
      COALESCE(sum(CASE WHEN e.account_code='cash' THEN CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END ELSE 0 END),0)::text cash,
      COALESCE(sum(CASE WHEN e.account_class='expense' THEN CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END ELSE 0 END),0)::text expense,
      COALESCE(sum(CASE WHEN e.account_code='expense_refund_receivable' THEN CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END ELSE 0 END),0)::text refund
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND t.source_id=$1`, [id])).rows[0];
  }
  async function zero(id: string) {
    const amounts = await net(id);
    for (const value of Object.values(amounts)) expect(Number(value)).toBe(0);
    const agenda = await open('test', db.pool);
    expect([...agenda.a_pagar.itens, ...agenda.a_receber.itens].filter(r => r.id === id)).toEqual([]);
  }
  it('anula à vista, preserva o original e não altera uma compra de estoque', async () => {
    const { registerWholesalePurchase: register } = await import('../../src/admin/painel/queries-fornecedores-registro.js');
    const supplier = (await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name)
      VALUES ('test','Fornecedor de lotes') RETURNING id`)).rows[0].id;
    const purchase = await register({ environment: 'test', supplier_id: supplier, items: [],
      lot: { description: '210 pneus', quantity: 210, total_cost: 3850 },
      payment_status: 'paid', payment_method: 'Pix', receipt_status: 'received',
      created_by: 'owner:test', idempotency_key: randomUUID() }, db.pool);
    const snapshot = async () => (await db.pool.query(`SELECT jsonb_build_object(
      'purchase',(SELECT to_jsonb(p) FROM commerce.wholesale_purchases p WHERE p.id=$1),
      'lot',(SELECT to_jsonb(l) FROM commerce.tire_lots l WHERE l.id=$2),
      'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM finance.matriz_ledger_transactions t
        WHERE t.environment='test' AND t.source_id=$1::text)) data`, [purchase.purchase_id, purchase.lot_id])).rows;
    const before = await snapshot();
    const e = await create(); const request = input(e.id);
    const result = await cancel(request, 'owner:test', 'test', db.pool);
    expect(result.cash_correction).toBe('3900.00'); expect(result.reversal_ids).toHaveLength(1);
    expect(await cancel(request, 'owner:test', 'test', db.pool)).toEqual(result);
    await expect(cancel({ ...request, reason: 'Outro motivo' }, 'owner:test', 'test', db.pool)).rejects.toThrow('idempotency_conflict');
    await expect(cancel(input(e.id), 'owner:test', 'test', db.pool)).rejects.toThrow('expense_already_cancelled');
    await zero(e.id);
    expect(await snapshot()).toEqual(before);
    expect((await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_id=$1 AND source_type='commerce.matriz_expense.accrual'`, [e.id])).rows[0].n).toBe(1);
  });
  it('cancela pendente sem movimentar caixa', async () => {
    const e = await create(false);
    expect((await cancel(input(e.id), 'owner:test', 'test', db.pool)).cash_correction).toBe('0.00');
    await zero(e.id);
  });
  it('desfaz baixa vinculada antes de cancelar despesa quitada depois', async () => {
    const e = await create(false);
    await expenses.settleMatrizExpense(e.id, 'test', db.pool, { idempotency_key: randomUUID(), actor_label: 'owner:test' });
    const result = await cancel(input(e.id), 'owner:test', 'test', db.pool);
    expect(result.reversal_ids).toHaveLength(2); await zero(e.id);
    expect((await db.pool.query(`SELECT payment_kind FROM finance.matriz_ledger_payments p
      JOIN finance.matriz_ledger_transactions t ON t.id=p.obligation_transaction_id
      WHERE t.source_id=$1 ORDER BY p.payment_kind`, [e.id])).rows.map(r => r.payment_kind)).toEqual(['reversal', 'settlement']);
  });
  it('corrige remoção antiga e o backfill não recria valor a recuperar', async () => {
    const e = await create();
    await remove(e.id, 'test', db.pool, { reason: 'erro meu', actor_label: 'owner:test', idempotency_key: randomUUID() });
    expect(Number((await net(e.id)).refund)).toBe(3900);
    expect((await cancel(input(e.id), 'owner:test', 'test', db.pool)).reversal_ids).toHaveLength(2);
    await zero(e.id);
    const { runMatrizStage4LedgerBackfill: backfill } = await import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js');
    expect((await backfill({ environment: 'test' }, db.pool)).processed.expenses).toBe(0);
    await zero(e.id);
  });
  it('reconhece pendente já removida sem estornar duas vezes', async () => {
    const e = await create(false);
    await remove(e.id, 'test', db.pool, { reason: 'erro', idempotency_key: randomUUID() });
    await cancel(input(e.id), 'owner:test', 'test', db.pool); await zero(e.id);
  });
  it('recusa devolução parcialmente recebida e desfaz toda a tentativa', async () => {
    const e = await create();
    await remove(e.id, 'test', db.pool, { reason: 'devolução real', idempotency_key: randomUUID() });
    const title = (await open('test', db.pool)).a_receber.itens.find(r => r.id === e.id)!;
    const { settleMatrizLedgerOpenItem: settle } = await import('../../src/admin/painel/matriz-ledger-settlement.js');
    await settle({ environment: 'test', obligation_id: title.obligation_id!, amount: 100,
      actor_label: 'owner:test', idempotency_key: randomUUID() }, db.pool);
    const before = await net(e.id);
    await expect(cancel(input(e.id), 'owner:test', 'test', db.pool)).rejects.toThrow('expense_refund_has_payments');
    expect(await net(e.id)).toEqual(before);
  });
  it('isola ambiente e serializa cancelamentos concorrentes', async () => {
    const e = await create();
    await expect(cancel(input(e.id), 'owner:test', 'prod', db.pool)).rejects.toThrow('expense_not_found');
    const requests = await Promise.allSettled([cancel(input(e.id), 'owner:test', 'test', db.pool),
      cancel(input(e.id), 'owner:test', 'test', db.pool)]);
    expect(requests.filter(r => r.status === 'fulfilled')).toHaveLength(1); await zero(e.id);
  });
  it('bloqueia despesa de rota sem alterar seus vínculos', async () => {
    const trip = await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
      VALUES ('test','Entregador teste') RETURNING id`);
    const receipt = await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts
      (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',18,'skipped','review_required') RETURNING id`, [trip.rows[0].id]);
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
      VALUES ($1,'test',convert_to('comprovante-teste','UTF8'))`, [receipt.rows[0].id]);
    const today = (await db.pool.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today`)).rows[0].today;
    const { approveMatrizTripReceipt: approve } = await import('../../src/admin/painel/queries-logistica-comprovantes-decision.js');
    const approved = await approve({ environment: 'test', receipt_id: receipt.rows[0].id,
      amount: 64.5, category: 'combustivel', merchant: 'Posto teste', document_date: today,
      competence_month: today.slice(0, 7) + '-01', payment_status: 'paid', payment_date: today,
      actor_label: 'owner:test', idempotency_key: randomUUID() }, db.pool);
    const before = await net(approved.expense_id);
    await expect(cancel(input(approved.expense_id), 'owner:test', 'test', db.pool)).rejects.toThrow('expense_cancellation_linked');
    expect(await net(approved.expense_id)).toEqual(before);
  });
  it('corrige saldo e gráfico sem apagar a saída histórica', async () => {
    const e = await create(true, '2026-07-01T15:00:00Z');
    await cancel(input(e.id), 'owner:test', 'test', db.pool);
    const { getMatrizFinanceOverview: overview } = await import('../../src/admin/painel/matriz-finance-overview.js');
    const old = await overview('2026-07', 'test', db.pool);
    expect(Number(old.days.find(d => d.date === '2026-07-01')!.outgoing)).toBe(3900);
    const reversed = await db.pool.query(`SELECT cash_on::text date FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_id=$1 AND source_type='commerce.matriz_expense.cancel'`, [e.id]);
    expect(reversed.rows[0].date).not.toBe('2026-07-01'); await zero(e.id);
  });
});
