import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** Runs against a fresh, fully migrated database; never uses the default pool. */
export async function proveLotPurchases(pool: Pool) {
  const { registerWholesalePurchase: register, confirmWholesalePurchase: receive } =
    await import('../../../src/admin/painel/queries-fornecedores-registro.js');
  const { cancelWholesalePurchase: cancel } =
    await import('../../../src/admin/painel/queries-fornecedores-cancel.js');
  const { getWholesalePurchaseReport: report } =
    await import('../../../src/admin/painel/queries-compras-relatorios.js');
  const { settleWholesalePurchasePayment: settle } =
    await import('../../../src/admin/painel/queries-financeiro-integridade.js');
  const scalar = async (sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows[0];
  const initial = await scalar(`SELECT (SELECT count(*) FROM commerce.products)::int products,
    (SELECT count(*) FROM commerce.wholesale_stock)::int stock`);
  const supplier = await scalar(`INSERT INTO commerce.wholesale_suppliers(environment,name)
    VALUES ('test','Fornecedor de lotes QA') RETURNING id`);
  const input = (paid: boolean, received: boolean) => ({ environment: 'test' as const,
    supplier_id: supplier.id, items: [], lot: { description: 'Pneus para borracharia', quantity: 3, total_cost: 100 },
    purchased_at: '2026-08-01T15:00:00Z', received_at: '2026-08-02T15:00:00Z',
    paid_at: '2026-08-03T15:00:00Z', created_by: 'owner:lot-proof',
    payment_status: paid ? 'paid' as const : 'pending' as const,
    receipt_status: received ? 'received' as const : 'pending' as const,
    due_date: '2026-12-01', payment_method: 'Pix', freight_amount: 12.34, discount_amount: 2.34,
    idempotency_key: randomUUID() });
  const scenarios: string[] = [];
  for (const paid of [true, false]) for (const received of [true, false]) {
    const body = input(paid, received);
    const purchase = await register(body, pool);
    assert.equal(purchase.total_amount, '110.00');
    assert(purchase.lot_id); assert.match(purchase.lot_code!, /^LT-\d+$/);
    assert.deepEqual(await register(body, pool), purchase, 'retry must replay one purchase');
    await assert.rejects(() => register({ ...body, lot: { ...body.lot, quantity: 4 } }, pool), /idempotency/);
    let lot = await scalar(`SELECT * FROM commerce.tire_lots WHERE id=$1`, [purchase.lot_id]);
    assert.equal(lot.quantity_on_hand, received ? 3 : 0);
    assert.equal(Number(lot.remaining_cost), received ? 110 : 0);
    assert.equal(Number(lot.products_amount), 100);
    const accrual = await scalar(`SELECT t.amount::text, t.transaction_kind,
      jsonb_object_agg(e.account_code,e.side) entries FROM finance.matriz_ledger_transactions t
      JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND t.source_type='commerce.wholesale_purchase.accrual'
        AND t.source_id=$1 GROUP BY t.id`, [purchase.purchase_id]);
    assert.equal(Number(accrual.amount), 110);
    assert.equal(accrual.entries[received ? 'inventory' : 'inventory_in_transit'], 'debit');
    assert.equal(accrual.entries[paid ? 'cash' : 'accounts_payable'], 'credit');
    const installments = await scalar(`SELECT count(*)::int n,COALESCE(sum(amount),0)::text total
      FROM commerce.wholesale_purchase_installments WHERE purchase_id=$1`, [purchase.purchase_id]);
    assert.equal(installments.n, paid ? 0 : 1);
    assert.equal(Number(installments.total), paid ? 0 : 110);
    if (!received) {
      const confirmation = { environment: 'test' as const, purchase_id: purchase.purchase_id,
        confirmed_by: 'owner:lot-proof', idempotency_key: randomUUID(),
        items: [{ item_id: purchase.lot_id!, accepted_quantity: 3 }] };
      await assert.rejects(() => receive({ ...confirmation, environment: 'prod' }, pool), /purchase_not_found/);
      await assert.rejects(() => receive({ ...confirmation,
        items: [{ item_id: purchase.lot_id!, accepted_quantity: 2 }] }, pool), /lot_receipt_quantity_mismatch/);
      const receipt = await receive(confirmation, pool);
      assert.deepEqual(await receive(confirmation, pool), receipt);
      lot = await scalar(`SELECT * FROM commerce.tire_lots WHERE id=$1`, [purchase.lot_id]);
      assert.equal(lot.quantity_on_hand, 3); assert.equal(Number(lot.remaining_cost), 110);
      const moved = await scalar(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
        WHERE source_type='commerce.wholesale_purchase.receipt' AND source_id=$1`, [purchase.purchase_id]);
      assert.equal(moved.n, 1);
    }
    const cancellation = { environment: 'test' as const, purchase_id: purchase.purchase_id,
      cancelled_by: 'owner:lot-proof', reason: 'Devolução integral', idempotency_key: randomUUID() };
    await pool.query(`UPDATE commerce.tire_lots SET quantity_reserved=1 WHERE id=$1`, [purchase.lot_id]);
    await assert.rejects(() => cancel(cancellation, pool), /purchase_stock_consumed/);
    await pool.query(`UPDATE commerce.tire_lots SET quantity_reserved=0 WHERE id=$1`, [purchase.lot_id]);
    const cancelled = await cancel(cancellation, pool);
    assert.deepEqual(await cancel(cancellation, pool), cancelled);
    lot = await scalar(`SELECT * FROM commerce.tire_lots WHERE id=$1`, [purchase.lot_id]);
    assert.equal(lot.quantity_on_hand, 0); assert.equal(Number(lot.remaining_cost), 0);
    const movements = await scalar(`SELECT count(*)::int n,sum(quantity_delta)::int qty,
      sum(cost_delta)::text cost FROM commerce.tire_lot_movements WHERE lot_id=$1`, [purchase.lot_id]);
    assert.deepEqual(movements, { n: 2, qty: 0, cost: '0.00' });
    await assert.rejects(() => pool.query(`DELETE FROM commerce.tire_lot_movements WHERE lot_id=$1`, [purchase.lot_id]), /immutable/);
    scenarios.push(`${paid ? 'paga' : 'a prazo'} / ${received ? 'recebida' : 'a caminho'} / cancelamento`);
  }
  // Cancellation before receipt must not invent a stock movement.
  const pending = await register(input(false, false), pool);
  await cancel({ environment: 'test', purchase_id: pending.purchase_id, cancelled_by: 'owner:lot-proof',
    reason: 'Fornecedor cancelou', idempotency_key: randomUUID() }, pool);
  assert.equal((await scalar(`SELECT count(*)::int n FROM commerce.tire_lot_movements WHERE lot_id=$1`, [pending.lot_id])).n, 0);
  const payable = await register(input(false, true), pool);
  const paymentOptions = { idempotency_key: randomUUID(), actor_label: 'owner:lot-proof',
    paid_at: '2026-08-05T15:00:00Z', payment_method: 'pix', cash_account: 'cash' };
  const paid = await settle(payable.purchase_id, 'test', pool, paymentOptions);
  assert.deepEqual(await settle(payable.purchase_id, 'test', pool, paymentOptions), paid);
  assert.equal((await scalar(`SELECT payment_status FROM commerce.wholesale_purchases WHERE id=$1`, [payable.purchase_id])).payment_status, 'paid');
  assert.equal((await scalar(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
    WHERE source_type='commerce.wholesale_purchase.payment' AND source_id=$1`, [payable.purchase_id])).n, 1);
  const history = await report({ period: 'all', status: 'all', payment: 'all', page: 1, pageSize: 50 }, 'test', pool);
  assert.equal(history.rows.length, 6, 'history must include lots without catalog items');
  assert(history.rows.every((r: any) => r.purchase_kind === 'lot' && r.items.length === 1 && r.items[0].item_kind === 'lot'));
  const { readPurchaseReportLines } = await import('../../../src/admin/painel/purchase-report-data.js');
  const { purchaseReportQuery } = await import('../../../src/admin/painel/purchase-report-period.js');
  const lines = await readPurchaseReportLines(pool, 'test', purchaseReportQuery.parse({ from: '2026-08-01', to: '2026-08-31', compare: 'false' }));
  assert.equal(lines.length, 1); assert.equal(lines[0]!.value, 11000);
  assert.equal(lines[0]!.quantity, 3); assert.equal(lines[0]!.open, 0);
  assert.equal((await scalar(`SELECT has_table_privilege('farejador_partner_app','commerce.tire_lots','SELECT') allowed`)).allowed, false);
  const health = await scalar(`SELECT finance.matriz_stage3_ledger_reconciliation('test') health`);
  for (const [key, value] of Object.entries(health.health)) assert.equal(Number(value), 0, key);
  assert.deepEqual(await scalar(`SELECT (SELECT count(*) FROM commerce.products)::int products,
    (SELECT count(*) FROM commerce.wholesale_stock)::int stock`), initial, 'catalog and bot stock must remain untouched');
  const balance = await scalar(`SELECT COALESCE(sum(CASE WHEN side='debit' THEN amount ELSE -amount END),0)::text net
    FROM finance.matriz_ledger_entries WHERE environment='test'`);
  assert.equal(Number(balance.net), 0, 'all ledger entries balance');
  assert.equal((await scalar(`SELECT count(*)::int n FROM commerce.tire_lots WHERE environment='prod'`)).n, 0);
  return scenarios;
}
