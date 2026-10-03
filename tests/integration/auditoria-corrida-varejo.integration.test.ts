import { futureDueDate } from './helpers/business-dates.js';
// AUDITORIA 02/10/2026 - F2.1 corrida cancelar x receber parte (varejo).
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForDatabaseBlock, pauseNextCommit } from './helpers/database-barrier.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: cancelamento x recebimento parcial simultaneos', () => {
  let db: IntegrationDb;
  let seq = 0;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    await db.pool.query(`INSERT INTO core.units (environment, slug, name, is_active)
      VALUES ('test','main','Matriz',true) ON CONFLICT (environment, slug) DO UPDATE SET is_active=true`);
  }, 240_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function fiadoSale(): Promise<{ orderId: string; revenueId: string }> {
    seq += 1;
    const measure = `${120 + seq}/${60 + seq}-${14 + seq}`;
    const product = (await db.pool.query(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test',$1,$2,'tire','Sem marca','meia_vida') RETURNING id`, [`AUD-${seq}`, `Pneu ${seq}`])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size) VALUES ('test',$1,$2)`, [product, measure]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost) VALUES ('test',$1,5,40)`, [measure]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices (environment,product_id,price_amount,currency,valid_from)
      VALUES ('test',$1,120,'BRL','2026-01-01T00:00:00Z')`, [product]);
    const { registerWalkinOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const { order_id } = await registerWalkinOrder({ environment: 'test', customer_name: 'Cliente Fiado', customer_phone: null,
      unit_id: null, items: [{ product_id: product, quantity: 1, unit_price: 120 }], payment_method: 'a receber',
      payment_due_on: futureDueDate(), fulfillment_mode: 'pickup', delivery_address: null, actor_label: 'auditoria',
      idempotency_key: `aud-fiado-${seq}-${Date.now()}`, source_tag: 'walkin_balcao' } as never, db.pool);
    const revenueId = (await db.pool.query(`SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='commerce.order.revenue' AND source_id=$1`, [order_id])).rows[0].id;
    return { orderId: order_id, revenueId };
  }

  async function balances(orderId: string) {
    const r = await db.pool.query(`SELECT e.account_code,
        sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)::numeric(14,2)::text net
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND (t.source_id=$1 OR t.metadata->>'order_id'=$1 OR t.metadata->>'source_id'=$1
        OR t.id IN (SELECT payment_transaction_id FROM finance.matriz_ledger_payments p
          JOIN finance.matriz_ledger_transactions o ON o.id=p.obligation_transaction_id WHERE o.source_id=$1))
      GROUP BY e.account_code ORDER BY 1`, [orderId]);
    return Object.fromEntries(r.rows.map((x: { account_code: string; net: string }) => [x.account_code, x.net]));
  }

  it('cancelamento vence: recebimento bloqueado relê o estado e não movimenta caixa', async () => {
    const { orderId, revenueId } = await fiadoSale();
    const { cancelManualOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const { settleMatrizLedgerOpenItem } = await import('../../src/admin/painel/matriz-ledger-settlement.js');
    const pause = pauseNextCommit(db.pool);
    const cancel = cancelManualOrder({ order_id: orderId, actor_label: 'auditoria', reason: 'teste', environment: 'test' }, pause.db);
    let receipt: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([pause.reached, cancel.then(() => { throw new Error('commit não interceptado'); })]);
      receipt = settleMatrizLedgerOpenItem({ environment: 'test', obligation_id: revenueId, amount: 50,
        idempotency_key: `cancel-first-${orderId}`, actor_label: 'auditoria' }, db.pool)
        .then(() => 'pagamento indevido', (error: Error) => error.message);
      await waitForDatabaseBlock(db.pool, pid);
    } finally { pause.resume(); await cancel; }
    expect(await receipt).toBe('central_obligation_not_actionable');
    const b = await balances(orderId);
    expect(b.accounts_receivable).toBe('0.00');
    expect(Number(b.cash ?? 0)).toBe(0);
    expect(Number(b.customer_refund_payable ?? 0)).toBe(0);
  });

  it('sequencial (paga 50, depois cancela): o certo', async () => {
    const { orderId, revenueId } = await fiadoSale();
    const { lockSettlementObligation, recordSettlementPayment } = await import('../../src/admin/painel/matriz-ledger-settlement-payment.js');
    const c = await db.pool.connect();
    await c.query('BEGIN');
    const ob = await lockSettlementObligation(c, 'test', revenueId);
    await recordSettlementPayment(c, 'test', ob, 50, new Date().toISOString(), 'caixa', 'commerce.order.partial_payment', `seq-${orderId}`, {});
    await c.query('COMMIT'); c.release();
    const { cancelManualOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    await cancelManualOrder({ order_id: orderId, actor_label: 'auditoria', reason: 'teste', environment: 'test' } as never, db.pool);
    const b = await balances(orderId);
    console.log('SEQUENCIAL', JSON.stringify(b));
    expect(b.accounts_receivable).toBe('0.00');
    expect(b.customer_refund_payable).toBe('-50.00');
  });

  it('simultaneo (pagamento ainda aberto quando o cancelamento le o saldo)', async () => {
    const { orderId, revenueId } = await fiadoSale();
    const { lockSettlementObligation, recordSettlementPayment } = await import('../../src/admin/painel/matriz-ledger-settlement-payment.js');
    const c = await db.pool.connect();
    await c.query('BEGIN');
    const ob = await lockSettlementObligation(c, 'test', revenueId);
    await recordSettlementPayment(c, 'test', ob, 50, new Date().toISOString(), 'caixa', 'commerce.order.partial_payment', `race-${orderId}`, {});
    const { cancelManualOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const cancel = cancelManualOrder({ order_id: orderId, actor_label: 'auditoria', reason: 'teste', environment: 'test' } as never, db.pool)
      .then(() => 'ok', (e: Error) => `erro: ${e.message}`);
    await waitForDatabaseBlock(db.pool, (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await c.query('COMMIT'); c.release();
    const outcome = await cancel;
    const b = await balances(orderId);
    const payments = (await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_payments WHERE obligation_transaction_id=$1`, [revenueId])).rows[0].n;
    const reversal = (await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions WHERE reversal_of_transaction_id=$1`, [revenueId])).rows[0].n;
    console.log('SIMULTANEO cancelamento:', outcome, '| saldos:', JSON.stringify(b), '| pagamentos:', payments, '| estornos totais:', reversal);
    expect(outcome).toBe('ok');
    expect(b.customer_refund_payable).toBe('-50.00');
    // O certo seria igual ao sequencial: a receber 0 e 50 a devolver ao cliente.
    expect(b.accounts_receivable).toBe('0.00');
  });
});
