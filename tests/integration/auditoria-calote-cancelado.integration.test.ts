import { futureDueDate } from './helpers/business-dates.js';
// AUDITORIA 02/10/2026 - F1.1 calote + cancelamento cria devolucao falsa.
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: calote baixado e depois venda cancelada (cliente devolveu o pneu)', () => {
  let db: IntegrationDb;
  let seq = 0;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    await db.pool.query(`INSERT INTO core.units (environment, slug, name, is_active)
      VALUES ('test','main','Matriz',true) ON CONFLICT (environment, slug) DO UPDATE SET is_active=true`);
  }, 240_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function net(sourceId: string, obligationId: string) {
    const r = await db.pool.query(`SELECT e.account_code,
        sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)::numeric(14,2)::text net
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND (t.source_id=$1 OR t.metadata->>'obligation_id'=$2::text
        OR t.id IN (SELECT payment_transaction_id FROM finance.matriz_ledger_payments WHERE obligation_transaction_id=$2::uuid))
      GROUP BY e.account_code ORDER BY 1`, [sourceId, obligationId]);
    return Object.fromEntries(r.rows.map((x: { account_code: string; net: string }) => [x.account_code, x.net]));
  }

  it.each([0, 60])('ATACADO: recebe %s de 300, baixa saldo como calote, cancela e devolve só o recebido', async (paid) => {
    seq += 1;
    const measure = `${240 + seq}/${35 + seq}-${13 + seq}`;
    const product = (await db.pool.query(`INSERT INTO commerce.products (environment,product_code,product_name,product_type)
      VALUES ('test',$1,$2,'tire') RETURNING id`, [`AUD-CAL-${seq}`, `Pneu ${seq}`])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,$2,$3,$4,$5)`, [product, measure, 240 + seq, 35 + seq, 13 + seq]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost) VALUES ('test',$1,10,40)`, [measure]);
    const buyer = (await db.pool.query(`INSERT INTO commerce.wholesale_customers (environment,name) VALUES ('test','Borracheiro caloteiro') RETURNING id`)).rows[0].id;
    const { registerWholesaleSale } = await import('../../src/admin/painel/queries-atacado-vendas.js');
    const sale = await registerWholesaleSale({ environment: 'test', customer_id: buyer, items: [{ measure, quantity: 3, unit_price: 100 }],
      sold_at: '2026-09-20T14:00:00Z', payment_status: 'pending', due_date: futureDueDate(), created_by: 'owner', idempotency_key: randomUUID() } as never, db.pool);
    const revenueId = (await db.pool.query(`SELECT id FROM finance.matriz_ledger_transactions WHERE environment='test'
      AND source_type='commerce.wholesale_order.revenue' AND source_id=$1`, [sale.order_id])).rows[0].id;
    const { writeOffMatrizCredit } = await import('../../src/admin/painel/matriz-ledger-writeoff.js');
    if (paid) {
      const { lockSettlementObligation, recordSettlementPayment } = await import('../../src/admin/painel/matriz-ledger-settlement-payment.js');
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const obligation = await lockSettlementObligation(client, 'test', revenueId);
        await recordSettlementPayment(client, 'test', obligation, paid, new Date().toISOString(), 'auditoria',
          'commerce.wholesale_order.partial_payment', randomUUID(), {});
        await client.query('COMMIT');
      } finally { client.release(); }
    }
    await writeOffMatrizCredit({ environment: 'test', obligation_id: revenueId, reason: 'cliente sumiu, calote', idempotency_key: randomUUID() }, db.pool);
    const { cancelWholesaleSale } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
    const res = await cancelWholesaleSale({ environment: 'test', order_id: sale.order_id, reason: 'cliente devolveu os pneus', cancelled_by: 'owner', idempotency_key: randomUUID() } as never, db.pool)
      .then(() => 'ok', (e: Error) => `erro: ${e.message}`);
    const b = await net(sale.order_id, revenueId);
    const stock = (await db.pool.query(`SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE environment='test' AND measure=$1`, [measure])).rows[0].quantity_on_hand;
    console.log('ATACADO CALOTE+CANCELA:', res, '| estoque:', stock, '| contas:', JSON.stringify(b));
    expect(res).toBe('ok');
    expect(stock).toBe(10);
    expect(Number(b.customer_refund_payable ?? 0)).toBe(paid ? -paid : 0);
    expect(Number(b.accounts_receivable ?? 0)).toBe(0);
    expect(Number(b.bad_debt_expense ?? 0)).toBe(0);
  });

  it('VAREJO: venda de balcao fiada 120, baixa como calote, cancela', async () => {
    seq += 1;
    const measure = `${120 + seq}/${60 + seq}-${14 + seq}`;
    const product = (await db.pool.query(`INSERT INTO commerce.products (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test',$1,$2,'tire','Sem marca','meia_vida') RETURNING id`, [`AUD-CALV-${seq}`, `Pneu ${seq}`])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size) VALUES ('test',$1,$2)`, [product, measure]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost) VALUES ('test',$1,5,40)`, [measure]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices (environment,product_id,price_amount,currency,valid_from)
      VALUES ('test',$1,120,'BRL','2026-01-01T00:00:00Z')`, [product]);
    const { registerWalkinOrder, cancelManualOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const { order_id } = await registerWalkinOrder({ environment: 'test', customer_name: 'Cliente', customer_phone: null, unit_id: null,
      items: [{ product_id: product, quantity: 1, unit_price: 120 }], payment_method: 'a receber', payment_due_on: futureDueDate(),
      fulfillment_mode: 'pickup', delivery_address: null, actor_label: 'auditoria', idempotency_key: randomUUID(), source_tag: 'walkin_balcao' } as never, db.pool);
    const revenueId = (await db.pool.query(`SELECT id FROM finance.matriz_ledger_transactions WHERE environment='test'
      AND source_type='commerce.order.revenue' AND source_id=$1`, [order_id])).rows[0].id;
    const { writeOffMatrizCredit } = await import('../../src/admin/painel/matriz-ledger-writeoff.js');
    await writeOffMatrizCredit({ environment: 'test', obligation_id: revenueId, reason: 'cliente nao pagou', idempotency_key: randomUUID() }, db.pool);
    await cancelManualOrder({ order_id, actor_label: 'auditoria', reason: 'devolveu o pneu', environment: 'test' } as never, db.pool);
    const b = await net(order_id, revenueId);
    console.log('VAREJO CALOTE+CANCELA:', JSON.stringify(b));
    expect(b.customer_refund_payable ?? '0.00').toBe('0.00');
  });
});
