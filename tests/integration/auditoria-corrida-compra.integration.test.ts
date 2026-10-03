import { futureDueDate } from './helpers/business-dates.js';
// AUDITORIA 02/10/2026 - F2.1 corrida cancelar x pagar parte (compra).
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
import { randomUUID } from 'node:crypto';
import { waitForDatabaseBlock, pauseNextCommit } from './helpers/database-barrier.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: compra a prazo, cancelamento x pagamento parcial simultaneos', () => {
  let db: IntegrationDb;
  let seq = 0;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
  }, 240_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function prazo() {
    seq += 1;
    const measure = `${210 + seq}/${40 + seq}-${12 + seq}`;
    const product = (await db.pool.query(`INSERT INTO commerce.products (environment,product_code,product_name,product_type)
      VALUES ('test',$1,$2,'tire') RETURNING id`, [`AUD-CP-${seq}`, `Pneu compra ${seq}`])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,$2,$3,$4,$5)`, [product, measure, 210 + seq, 40 + seq, 12 + seq]);
    const { registerWholesaleSupplier } = await import('../../src/admin/painel/queries-fornecedores.js');
    const supplier = await registerWholesaleSupplier({ environment: 'test', name: `Fornecedor ${seq}`, phone: `2197${String(seq).padStart(6, '0')}` } as never, db.pool);
    const { registerWholesalePurchase } = await import('../../src/admin/painel/queries-fornecedores-registro.js');
    const p = await registerWholesalePurchase({ environment: 'test', supplier_id: supplier.id,
      items: [{ measure, quantity: 4, unit_cost: 50 }], purchased_at: '2026-09-20T14:00:00Z',
      payment_status: 'pending', due_date: futureDueDate(), receipt_status: 'received',
      created_by: 'owner:auditoria', idempotency_key: randomUUID() } as never, db.pool);
    const purchaseId = (p as { purchase_id?: string; id?: string }).purchase_id ?? (p as { id: string }).id;
    const accrualId = (await db.pool.query(`SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='commerce.wholesale_purchase.accrual' AND source_id=$1`, [purchaseId])).rows[0].id;
    return { purchaseId: purchaseId as string, accrualId: accrualId as string };
  }

  async function balances(purchaseId: string, accrualId: string) {
    const r = await db.pool.query(`SELECT e.account_code,
        sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)::numeric(14,2)::text net
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND (t.source_id=$1 OR t.id IN (SELECT payment_transaction_id FROM finance.matriz_ledger_payments WHERE obligation_transaction_id=$2))
      GROUP BY e.account_code ORDER BY 1`, [purchaseId, accrualId]);
    return Object.fromEntries(r.rows.map((x: { account_code: string; net: string }) => [x.account_code, x.net]));
  }

  async function partial(c: import('pg').PoolClient, accrualId: string, tag: string) {
    const { lockSettlementObligation, recordSettlementPayment } = await import('../../src/admin/painel/matriz-ledger-settlement-payment.js');
    const ob = await lockSettlementObligation(c, 'test', accrualId);
    await recordSettlementPayment(c, 'test', ob, 80, new Date().toISOString(), 'owner', 'commerce.wholesale_purchase.partial_payment', tag, {});
  }

  it('cancelamento vence: pagamento bloqueado não retira dinheiro do caixa', async () => {
    const { purchaseId, accrualId } = await prazo();
    const { cancelWholesalePurchase } = await import('../../src/admin/painel/queries-fornecedores-cancel.js');
    const { settleMatrizLedgerOpenItem } = await import('../../src/admin/painel/matriz-ledger-settlement.js');
    const pause = pauseNextCommit(db.pool);
    const cancel = cancelWholesalePurchase({ environment: 'test', purchase_id: purchaseId, reason: 'teste auditoria',
      cancelled_by: 'owner', idempotency_key: randomUUID() }, pause.db);
    let payment: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([pause.reached, cancel.then(() => { throw new Error('commit não interceptado'); })]);
      payment = settleMatrizLedgerOpenItem({ environment: 'test', obligation_id: accrualId, amount: 80,
        idempotency_key: randomUUID(), actor_label: 'owner' }, db.pool)
        .then(() => 'pagamento indevido', (error: Error) => error.message);
      await waitForDatabaseBlock(db.pool, pid);
    } finally { pause.resume(); await cancel; }
    expect(await payment).toBe('central_obligation_not_actionable');
    const b = await balances(purchaseId, accrualId);
    expect(b.accounts_payable).toBe('0.00');
    expect(Number(b.cash ?? 0)).toBe(0);
    expect(Number(b.supplier_refund_receivable ?? 0)).toBe(0);
  });

  it('sequencial: paga 80 e depois cancela (o certo)', async () => {
    const { purchaseId, accrualId } = await prazo();
    const c = await db.pool.connect(); await c.query('BEGIN'); await partial(c, accrualId, `seq-${purchaseId}`); await c.query('COMMIT'); c.release();
    const { cancelWholesalePurchase } = await import('../../src/admin/painel/queries-fornecedores-cancel.js');
    const r = await cancelWholesalePurchase({ environment: 'test', purchase_id: purchaseId, reason: 'teste auditoria', cancelled_by: 'owner', idempotency_key: randomUUID() } as never, db.pool).then(() => 'ok', (e: Error) => e.message);
    const b = await balances(purchaseId, accrualId);
    console.log('COMPRA SEQUENCIAL', r, JSON.stringify(b));
    expect(b.accounts_payable).toBe('0.00');
  });

  it('simultaneo: pagamento aberto quando o cancelamento le o saldo', async () => {
    const { purchaseId, accrualId } = await prazo();
    const c = await db.pool.connect(); await c.query('BEGIN'); await partial(c, accrualId, `race-${purchaseId}`);
    const { cancelWholesalePurchase } = await import('../../src/admin/painel/queries-fornecedores-cancel.js');
    const cancel = cancelWholesalePurchase({ environment: 'test', purchase_id: purchaseId, reason: 'teste auditoria', cancelled_by: 'owner', idempotency_key: randomUUID() } as never, db.pool)
      .then(() => 'ok', (e: Error) => `erro: ${e.message}`);
    await waitForDatabaseBlock(db.pool, (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await c.query('COMMIT'); c.release();
    const outcome = await cancel;
    const b = await balances(purchaseId, accrualId);
    console.log('COMPRA SIMULTANEO cancelamento:', outcome, '| saldos:', JSON.stringify(b));
    expect(outcome).toBe('ok');
    expect(b.accounts_payable).toBe('0.00');
  });
});
