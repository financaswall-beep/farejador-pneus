import { futureDueDate } from './helpers/business-dates.js';
// AUDITORIA 02/10/2026 - F2.1 corrida cancelar x receber parte (atacado).
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
import { randomUUID } from 'node:crypto';
import { waitForDatabaseBlock, pauseNextCommit } from './helpers/database-barrier.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: atacado fiado, cancelamento x recebimento parcial simultaneos', () => {
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

  async function fiadoSale() {
    seq += 1;
    const measure = `${240 + seq}/${35 + seq}-${13 + seq}`;
    const product = (await db.pool.query(`INSERT INTO commerce.products (environment,product_code,product_name,product_type)
      VALUES ('test',$1,$2,'tire') RETURNING id`, [`AUD-AT-${seq}`, `Pneu atacado ${seq}`])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,$2,$3,$4,$5)`, [product, measure, 240 + seq, 35 + seq, 13 + seq]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost) VALUES ('test',$1,10,40)`, [measure]);
    const buyer = (await db.pool.query(`INSERT INTO commerce.wholesale_customers (environment,name) VALUES ('test',$1) RETURNING id`, [`Borracheiro ${seq}`])).rows[0].id;
    const { registerWholesaleSale } = await import('../../src/admin/painel/queries-atacado-vendas.js');
    const r = await registerWholesaleSale({ environment: 'test', customer_id: buyer,
      items: [{ measure, quantity: 3, unit_price: 100 }], sold_at: '2026-09-20T14:00:00Z',
      payment_status: 'pending', due_date: futureDueDate(), created_by: 'owner:auditoria', idempotency_key: randomUUID() } as never, db.pool);
    const revenueId = (await db.pool.query(`SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='commerce.wholesale_order.revenue' AND source_id=$1`, [r.order_id])).rows[0].id;
    return { orderId: r.order_id as string, revenueId: revenueId as string };
  }

  async function balances(orderId: string, revenueId: string) {
    const r = await db.pool.query(`SELECT e.account_code,
        sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)::numeric(14,2)::text net
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND (t.source_id=$1 OR t.id IN (SELECT payment_transaction_id FROM finance.matriz_ledger_payments WHERE obligation_transaction_id=$2))
      GROUP BY e.account_code ORDER BY 1`, [orderId, revenueId]);
    return Object.fromEntries(r.rows.map((x: { account_code: string; net: string }) => [x.account_code, x.net]));
  }

  async function partial(c: import('pg').PoolClient, revenueId: string, tag: string) {
    const { lockSettlementObligation, recordSettlementPayment } = await import('../../src/admin/painel/matriz-ledger-settlement-payment.js');
    const ob = await lockSettlementObligation(c, 'test', revenueId);
    await recordSettlementPayment(c, 'test', ob, 100, new Date().toISOString(), 'owner', 'commerce.wholesale_order.partial_payment', tag, {});
  }

  it('cancelamento vence: tentativa posterior não recebe nem cria devolução', async () => {
    const { orderId, revenueId } = await fiadoSale();
    const { cancelWholesaleSale } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
    const { settleMatrizLedgerOpenItem } = await import('../../src/admin/painel/matriz-ledger-settlement.js');
    const pause = pauseNextCommit(db.pool);
    const cancel = cancelWholesaleSale({ environment: 'test', order_id: orderId, reason: 'teste auditoria',
      cancelled_by: 'owner', idempotency_key: randomUUID() }, pause.db);
    let receipt: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([pause.reached, cancel.then(() => { throw new Error('commit não interceptado'); })]);
      receipt = settleMatrizLedgerOpenItem({ environment: 'test', obligation_id: revenueId, amount: 100,
        idempotency_key: randomUUID(), actor_label: 'owner' }, db.pool)
        .then(() => 'pagamento indevido', (error: Error) => error.message);
      await waitForDatabaseBlock(db.pool, pid);
    } finally { pause.resume(); await cancel; }
    expect(await receipt).toBe('central_obligation_not_actionable');
    const b = await balances(orderId, revenueId);
    expect(b.accounts_receivable).toBe('0.00');
    expect(Number(b.cash ?? 0)).toBe(0);
    expect(Number(b.customer_refund_payable ?? 0)).toBe(0);
  });

  it('sequencial: recebe 100 e depois cancela (o certo)', async () => {
    const { orderId, revenueId } = await fiadoSale();
    const c = await db.pool.connect(); await c.query('BEGIN'); await partial(c, revenueId, `seq-${orderId}`); await c.query('COMMIT'); c.release();
    const { cancelWholesaleSale } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
    await cancelWholesaleSale({ environment: 'test', order_id: orderId, reason: 'teste auditoria', cancelled_by: 'owner', idempotency_key: randomUUID() } as never, db.pool);
    const b = await balances(orderId, revenueId);
    console.log('ATACADO SEQUENCIAL', JSON.stringify(b));
    expect(b.accounts_receivable).toBe('0.00');
    expect(b.customer_refund_payable).toBe('-100.00');
  });

  it('simultaneo: pagamento aberto quando o cancelamento le o saldo', async () => {
    const { orderId, revenueId } = await fiadoSale();
    const c = await db.pool.connect(); await c.query('BEGIN'); await partial(c, revenueId, `race-${orderId}`);
    const { cancelWholesaleSale } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
    const cancel = cancelWholesaleSale({ environment: 'test', order_id: orderId, reason: 'teste auditoria', cancelled_by: 'owner', idempotency_key: randomUUID() } as never, db.pool)
      .then(() => 'ok', (e: Error) => `erro: ${e.message}`);
    await waitForDatabaseBlock(db.pool, (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await c.query('COMMIT'); c.release();
    const outcome = await cancel;
    const b = await balances(orderId, revenueId);
    console.log('ATACADO SIMULTANEO cancelamento:', outcome, '| saldos:', JSON.stringify(b));
    expect(outcome).toBe('ok');
    expect(b.customer_refund_payable).toBe('-100.00');
    expect(b.accounts_receivable).toBe('0.00');
  });
});
